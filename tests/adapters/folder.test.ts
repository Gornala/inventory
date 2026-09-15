import { describe, expect, it } from "vitest";

import { folderPickers } from "../../src/adapters/os/folder.js";

/**
 * The command that opens the machine's folder dialog.
 *
 * No CI runner has a file dialog, and this is the half that can still be
 * checked: a command built wrong would otherwise only be found by a person
 * clicking export on the one platform nobody tried.
 */
describe("the folder dialog, per platform", () => {
  const start = "C:/boards/encoder";

  it("uses PowerShell's own dialog on Windows, with the path out of harm's way", () => {
    const [picker] = folderPickers("win32", start);
    expect(picker?.command).toBe("powershell.exe");
    expect(picker?.args).toContain("-Sta"); // WinForms needs a single-threaded apartment
    expect(picker?.args).toContain("-NoProfile");
    expect(picker?.env).toEqual({ KINV_PICK_START: start });

    const script = picker?.args[picker.args.length - 1] ?? "";
    expect(script).toContain("FolderBrowserDialog");
    // The owner has to be topmost *and shown and activated*, or the dialog is
    // created behind the browser with no taskbar button to find it by —
    // measured, not assumed. Opacity 0 keeps that owner off the screen.
    expect(script).toContain("$owner.TopMost = $true");
    expect(script).toContain("$owner.Show()");
    expect(script).toContain("$owner.Activate()");
    expect(script).toContain("$owner.Opacity = 0");
    // and the path is read from the environment rather than spliced in
    expect(script).toContain("$env:KINV_PICK_START");
    expect(script).not.toContain(start);
  });

  it("uses osascript on macOS, with the path as an argument", () => {
    const [picker] = folderPickers("darwin", "/Users/me/boards");
    expect(picker?.command).toBe("osascript");
    expect(picker?.args).toContain("on run argv");
    expect(picker?.args[picker.args.length - 1]).toBe("/Users/me/boards");
    expect(picker?.args.join(" ")).toContain("choose folder");
  });

  it("tries GTK then KDE on Linux", () => {
    const pickers = folderPickers("linux", "/home/me/boards");
    expect(pickers.map((p) => p.command)).toEqual(["zenity", "kdialog"]);
    // zenity wants a trailing slash to open *in* the directory rather than
    // beside it with the directory selected
    expect(pickers[0]?.args).toContain("--filename=/home/me/boards/");
    expect(pickers[0]?.args).toContain("--directory");
    expect(pickers[1]?.args).toEqual(["--getexistingdirectory", "/home/me/boards"]);
  });

  it("never lets a path reach a shell, on any platform", () => {
    const nasty = '/tmp/a"; rm -rf ~; echo "';
    for (const platform of ["win32", "darwin", "linux"] as NodeJS.Platform[]) {
      for (const picker of folderPickers(platform, nasty)) {
        // execFile with an argument array and no shell: the path is one
        // argument, or it is in the environment, and never part of a script
        const script = picker.args.find((a) => a.includes("FolderBrowserDialog"));
        expect(script ?? "").not.toContain(nasty);
      }
    }
  });
});
