import { execFile } from "node:child_process";

/**
 * The machine's own "choose a folder" dialog.
 *
 * The server and the browser are the same machine — that is the whole premise
 * of this tool — so the place to ask "where do you want these written?" is the
 * file dialog the operating system already has, rather than a directory tree
 * reimplemented in a page. It is the dialog you know, it can make a new folder,
 * and it starts where you last wrote.
 */
export type FolderChoice =
  | { status: "chosen"; dir: string }
  | { status: "cancelled" }
  /** No dialog on this machine: a headless box, or no display. Say so. */
  | { status: "unavailable"; reason: string };

export type PickerCommand = { command: string; args: string[]; env?: Record<string, string> };

/**
 * The Windows dialog, as a script rather than a command line.
 *
 * The starting directory travels in the environment instead of being spliced
 * into the script: a path with a quote in it would otherwise end the string it
 * was pasted into, and a local instrument is not a reason to write an
 * injectable command.
 *
 * The owner form is the whole trick, and it took a measurement to get right.
 * The process asking is not the one you are looking at, so Windows will not
 * hand it the foreground; a `FolderBrowserDialog` owned by nothing — or by a
 * form that merely *has* `TopMost` set and was never shown — is created
 * **behind the browser**, and an owned dialog gets no taskbar button, so there
 * is nothing to click and nothing to alt-tab to. That is what "I pressed
 * export and no dialog appeared" was: window enumeration found it open at
 * 1753,892 with `topmost=False`, sitting under the browser.
 *
 * An owner that is shown and activated fixes it — the dialog comes out
 * `topmost=True foreground=True`, measured. `Opacity = 0` keeps that owner off
 * the screen; it is a real window to the window manager and an invisible one
 * to you.
 */
const windowsScript = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = 'kinv — where should the upload files go?'",
  "$dialog.ShowNewFolderButton = $true",
  "if ($env:KINV_PICK_START) { $dialog.SelectedPath = $env:KINV_PICK_START }",
  "$owner = New-Object System.Windows.Forms.Form",
  "$owner.Text = 'kinv'",
  "$owner.TopMost = $true",
  "$owner.ShowInTaskbar = $false",
  "$owner.FormBorderStyle = 'None'",
  // Shown, so it can be activated; transparent, so it is never seen.
  "$owner.Opacity = 0",
  "$owner.Width = 1",
  "$owner.Height = 1",
  "$owner.StartPosition = 'CenterScreen'",
  "$owner.Show()",
  "$owner.Activate()",
  "if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) " +
    "{ [Console]::Out.Write($dialog.SelectedPath) }",
  "$owner.Dispose()",
].join("; ");

/**
 * What to run to open a folder dialog here, best candidate first.
 *
 * Separated from the running of it because this is the part that differs per
 * machine and the part worth testing: no CI runner has a file dialog, and a
 * command built wrong would otherwise only be found by a person clicking.
 */
export function folderPickers(platform: NodeJS.Platform, start: string): PickerCommand[] {
  if (platform === "win32") {
    return [
      {
        command: "powershell.exe",
        // -Sta because a WinForms dialog needs a single-threaded apartment,
        // -NoProfile so somebody's $PROFILE cannot print into stdout.
        args: ["-NoProfile", "-NonInteractive", "-Sta", "-Command", windowsScript],
        env: { KINV_PICK_START: start },
      },
    ];
  }

  if (platform === "darwin") {
    return [
      {
        command: "osascript",
        // The path goes in as an argument for the same reason as on Windows:
        // `on run argv` keeps it out of the script text entirely.
        args: [
          "-e",
          "on run argv",
          "-e",
          "POSIX path of (choose folder with prompt " +
            '"kinv — where should the upload files go?" ' +
            "default location POSIX file (item 1 of argv))",
          "-e",
          "end run",
          start,
        ],
      },
    ];
  }

  // GTK first, then KDE: whichever the desktop has. Both take the path as a
  // plain argument, and neither goes near a shell.
  return [
    {
      command: "zenity",
      args: [
        "--file-selection",
        "--directory",
        "--title=kinv — where should the upload files go?",
        `--filename=${start.replace(/\/*$/, "/")}`,
      ],
    },
    { command: "kdialog", args: ["--getexistingdirectory", start] },
  ];
}

/** A dialog nobody answers must not hold a request open for the afternoon. */
const timeoutMs = 5 * 60 * 1000;

type Ran = { stdout: string; stderr: string; missing: boolean; failed: boolean };

function run(picker: PickerCommand): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(
      picker.command,
      picker.args,
      {
        timeout: timeoutMs,
        ...(picker.env ? { env: { ...process.env, ...picker.env } } : {}),
      },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          missing: code === "ENOENT",
          failed: error != null,
        });
      },
    );
  });
}

/**
 * Opens the dialog and waits for an answer.
 *
 * Three outcomes, and they are kept apart on purpose. A folder is a folder. A
 * cancel writes nothing and says nothing — you changed your mind, that is not
 * an error. And a machine with no dialog at all has to be told apart from both,
 * because the page has a typed path to offer instead and would otherwise leave
 * you clicking a button that silently does nothing.
 */
export async function chooseFolder(start: string): Promise<FolderChoice> {
  const candidates = folderPickers(process.platform, start);
  let lastReason = "no folder dialog on this machine";

  for (const picker of candidates) {
    const ran = await run(picker);
    if (ran.missing) {
      lastReason = `${picker.command} is not installed`;
      continue;
    }

    const chosen = ran.stdout.trim();
    if (chosen !== "") return { status: "chosen", dir: chosen };

    // Nothing on stdout: either you cancelled, or the dialog never opened.
    // A cancel is quiet or says so; anything else on stderr is a machine that
    // cannot show one — no display, no GUI session, no assembly.
    const noise = ran.stderr.trim();
    if (ran.failed && noise !== "" && !/cancel/i.test(noise)) {
      lastReason = noise.split("\n")[0]?.slice(0, 200) ?? "the folder dialog failed";
      continue;
    }
    return { status: "cancelled" };
  }

  return { status: "unavailable", reason: lastReason };
}
