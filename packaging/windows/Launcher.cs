// Artifact Atlas for Windows: the program the user starts.
//
// It starts the bundled Node.js backend on a loopback port, shows the interface in a
// window of its own (Microsoft Edge or Chrome in app mode, with a separate profile kept in
// the app's data folder), and stops the backend when that window is closed.
// It never starts any program other than the bundled runtime and the browser.
//
// Written for the C# compiler that ships with Windows (.NET Framework 4), so it avoids
// newer language features.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

internal static class Launcher
{
    private const string AppName = "Artifact Atlas";
    private static readonly ManualResetEvent Ready = new ManualResetEvent(false);
    private static string serverUrl;

    [STAThread]
    private static int Main(string[] args)
    {
        bool smokeTest = Array.IndexOf(args, "--smoke-test") >= 0;
        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string node = Path.Combine(baseDir, "runtime", "node.exe");
        string cli = Path.Combine(baseDir, "app", "src", "cli.js");
        if (!File.Exists(node) || !File.Exists(cli))
        {
            return Fail("Some files are missing. Extract the whole ZIP file, then start ArtifactAtlas.exe from the extracted folder.", smokeTest, 2);
        }

        string dataDir = smokeTest
            ? Path.Combine(Path.GetTempPath(), "ArtifactAtlasSmoke-" + Process.GetCurrentProcess().Id)
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ArtifactAtlas");
        Directory.CreateDirectory(dataDir);
        string urlFile = Path.Combine(dataDir, "window-url.txt");

        bool isFirstInstance;
        Mutex mutex = new Mutex(true, "Local\\ArtifactAtlasDesktop" + (smokeTest ? "Smoke" : ""), out isFirstInstance);
        try
        {
            if (!isFirstInstance)
            {
                // Already running: show its window again instead of starting a second backend
                string runningUrl = File.Exists(urlFile) ? File.ReadAllText(urlFile).Trim() : "";
                if (IsHealthy(runningUrl))
                {
                    OpenWindow(runningUrl, dataDir);
                    return 0;
                }
                return Fail(AppName + " is already running.", smokeTest, 0);
            }

            Process backend = StartBackend(node, cli, dataDir);
            try
            {
                if (!Ready.WaitOne(TimeSpan.FromSeconds(45)) || serverUrl == null)
                {
                    return Fail(AppName + " could not start its local service.", smokeTest, 3);
                }
                if (smokeTest)
                {
                    return IsHealthy(serverUrl) ? 0 : 4;
                }
                File.WriteAllText(urlFile, serverUrl);

                DateTime openedAt = DateTime.UtcNow;
                Process window = OpenWindow(serverUrl, dataDir);
                if (window != null)
                {
                    window.WaitForExit();
                }
                // No app-mode browser, or it handed the page to a browser that was already
                // open: keep the service running until the user says they are done.
                if (window == null || (DateTime.UtcNow - openedAt).TotalSeconds < 4)
                {
                    MessageBox.Show(
                        AppName + " is open in your browser.\n\nClose this message when you are done to quit " + AppName + ".",
                        AppName, MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                return 0;
            }
            finally
            {
                try { File.Delete(urlFile); } catch (Exception) { }
                try { if (!backend.HasExited) { backend.Kill(); } } catch (Exception) { }
                if (smokeTest)
                {
                    try { backend.WaitForExit(5000); Directory.Delete(dataDir, true); } catch (Exception) { }
                }
            }
        }
        finally
        {
            if (isFirstInstance) { mutex.ReleaseMutex(); }
            mutex.Dispose();
        }
    }

    private static Process StartBackend(string node, string cli, string dataDir)
    {
        ProcessStartInfo info = new ProcessStartInfo();
        info.FileName = node;
        // The backend stops by itself when this program is gone (--parent-pid)
        info.Arguments = Quote(cli) + " serve --port 0 --data-dir " + Quote(dataDir)
            + " --parent-pid " + Process.GetCurrentProcess().Id;
        info.WorkingDirectory = Path.GetDirectoryName(node);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;

        Process backend = new Process();
        backend.StartInfo = info;
        backend.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
        {
            if (e.Data == null || !e.Data.StartsWith("ATLAS_SERVER_READY:")) { return; }
            Match match = Regex.Match(e.Data, "\"url\":\"(http://127\\.0\\.0\\.1:\\d+)\"");
            if (match.Success)
            {
                serverUrl = match.Groups[1].Value;
                Ready.Set();
            }
        };
        backend.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { };
        backend.Start();
        // Both streams are read for as long as the backend runs so it never blocks on output
        backend.BeginOutputReadLine();
        backend.BeginErrorReadLine();
        return backend;
    }

    private static bool IsHealthy(string url)
    {
        if (string.IsNullOrEmpty(url) || !url.StartsWith("http://127.0.0.1:")) { return false; }
        try
        {
            using (WebClient client = new WebClient())
            {
                client.Proxy = null;
                return client.DownloadString(url + "/api/health").Contains("\"ready\"");
            }
        }
        catch (Exception)
        {
            return false;
        }
    }

    // Opens the interface in a window of its own. Returns the browser process to wait for,
    // or null when the page was given to the default browser.
    private static Process OpenWindow(string url, string dataDir)
    {
        string browser = FindAppModeBrowser();
        if (browser != null)
        {
            try
            {
                ProcessStartInfo info = new ProcessStartInfo();
                info.FileName = browser;
                info.Arguments = "--app=" + url + "/"
                    + " --user-data-dir=" + Quote(Path.Combine(dataDir, "window"))
                    + " --no-first-run --no-default-browser-check --disable-background-mode"
                    + " --window-size=1360,880";
                info.UseShellExecute = false;
                return Process.Start(info);
            }
            catch (Exception) { }
        }
        try { Process.Start(url + "/"); } catch (Exception) { }
        return null;
    }

    private static string FindAppModeBrowser()
    {
        string[] roots = new string[]
        {
            Environment.GetEnvironmentVariable("ProgramFiles(x86)"),
            Environment.GetEnvironmentVariable("ProgramFiles"),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)
        };
        string[] browsers = new string[]
        {
            "Microsoft\\Edge\\Application\\msedge.exe",
            "Google\\Chrome\\Application\\chrome.exe"
        };
        foreach (string browser in browsers)
        {
            foreach (string root in roots)
            {
                if (string.IsNullOrEmpty(root)) { continue; }
                string candidate = Path.Combine(root, browser);
                if (File.Exists(candidate)) { return candidate; }
            }
        }
        return null;
    }

    private static string Quote(string value)
    {
        return "\"" + value.TrimEnd('\\') + "\"";
    }

    private static int Fail(string message, bool quiet, int code)
    {
        if (!quiet)
        {
            MessageBox.Show(message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        return code;
    }
}
