using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// Panel wrapper (path 3: stdio interposer for VSCode panel sessions).
// The VSCode Claude Code extension launches the panel's claude via this exe when
// claudeCode.claudeProcessWrapper points here. Per extension.js resolveClaudeBinary,
// we are spawned (no shell, over the extension's stdio pipes / stream-json) as:
//     panel-wrapper.exe <claudeExe-or-node> [cli.js] <...claude args>
// For an interactive session (args contain --input-format) we route claude through
// the Node interposer (node interposer.mjs <claudeExe> <args>) which taps the
// stream-json stdio. For utility spawns (auth status, chrome mcp, ...) we pass
// through unchanged. We always inherit stdio so the extension<->claude pipes bridge.
public class PanelWrapper {
    const string NodeExe = @"C:\Program Files\nodejs\node.exe";
    const string Interposer = @"D:\Projects\vassav\claude-tg-hub\hub-demo\panel\interposer.mjs";

    static string Quote(string s) {
        if (s.Length > 0 && s.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return s;
        var sb = new StringBuilder();
        sb.Append('"');
        int i = 0;
        while (i < s.Length) {
            int bs = 0;
            while (i < s.Length && s[i] == '\\') { i++; bs++; }
            if (i == s.Length) { sb.Append('\\', bs * 2); break; }
            else if (s[i] == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); i++; }
            else { sb.Append('\\', bs); sb.Append(s[i]); i++; }
        }
        sb.Append('"');
        return sb.ToString();
    }

    public static int Main(string[] args) {
        string log = Environment.GetEnvironmentVariable("PANEL_WRAPPER_LOG");
        if (string.IsNullOrEmpty(log)) log = Path.Combine(Path.GetTempPath(), "panel-wrapper.log");

        bool isSession = false;
        for (int i = 1; i < args.Length; i++) { if (args[i] == "--input-format") { isSession = true; break; } }

        try {
            var sb = new StringBuilder();
            sb.Append(DateTime.UtcNow.ToString("o")).Append("  SPAWN  argc=").Append(args.Length)
              .Append("  isSession=").Append(isSession).Append("  pid=").Append(Process.GetCurrentProcess().Id);
            sb.Append("\n    cwd=").Append(Directory.GetCurrentDirectory());
            for (int i = 0; i < args.Length; i++) sb.Append("\n    argv[").Append(i).Append("]=").Append(args[i]);
            File.AppendAllText(log, sb.ToString() + "\n");
        } catch { }

        if (args.Length == 0) { try { File.AppendAllText(log, "  ERROR no executable in argv\n"); } catch { } return 1; }

        try {
            var psi = new ProcessStartInfo();
            var sbArgs = new StringBuilder();
            if (isSession) {
                // node interposer.mjs <claudeExe> <...claudeArgs>
                psi.FileName = NodeExe;
                sbArgs.Append(Quote(Interposer));
                for (int i = 0; i < args.Length; i++) { sbArgs.Append(' ').Append(Quote(args[i])); }
                try { File.AppendAllText(log, "    ROUTED through interposer (" + Interposer + ")\n"); } catch { }
            } else {
                // passthrough: claudeExe <...args>
                psi.FileName = args[0];
                for (int i = 1; i < args.Length; i++) { if (sbArgs.Length > 0) sbArgs.Append(' '); sbArgs.Append(Quote(args[i])); }
            }
            psi.Arguments = sbArgs.ToString();
            psi.UseShellExecute = false;   // inherit the parent's std handles (the extension's pipes) — transparent
            var p = Process.Start(psi);
            p.WaitForExit();
            try { File.AppendAllText(log, DateTime.UtcNow.ToString("o") + "  EXIT code=" + p.ExitCode + "\n"); } catch { }
            return p.ExitCode;
        } catch (Exception e) {
            try { File.AppendAllText(log, DateTime.UtcNow.ToString("o") + "  CHILD_ERROR " + e.Message + "\n"); } catch { }
            return 1;
        }
    }
}
