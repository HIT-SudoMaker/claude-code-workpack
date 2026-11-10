using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

internal static class ConPtyTest
{
    [StructLayout(LayoutKind.Sequential)] private struct Coord { public short X, Y; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct StartupInfo
    {
        public int cb;
        public string reserved, desktop, title;
        public int x, y, xSize, ySize, xChars, yChars, fill, flags;
        public short show, reserved2Size;
        public IntPtr reserved2, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] private struct StartupInfoEx { public StartupInfo info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] private struct ProcessInfo { public IntPtr process, thread; public int processId, threadId; }

    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CreatePipe(out IntPtr read, out IntPtr write, IntPtr attributes, int size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern int CreatePseudoConsole(Coord size, IntPtr input, IntPtr output, int flags, out IntPtr console);
    [DllImport("kernel32.dll")] private static extern void ClosePseudoConsole(IntPtr console);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool UpdateProcThreadAttribute(IntPtr list, int flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
    [DllImport("kernel32.dll")] private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, int flags, IntPtr environment, string workingDirectory, ref StartupInfoEx startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ReadFile(IntPtr handle, byte[] buffer, int size, out int read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool WriteFile(IntPtr handle, byte[] buffer, int size, out int written, IntPtr overlapped);
    [DllImport("kernel32.dll")] private static extern uint WaitForSingleObject(IntPtr handle, int milliseconds);
    [DllImport("kernel32.dll")] private static extern bool TerminateProcess(IntPtr handle, int code);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr handle, out int code);

    private static readonly object Sync = new object();
    private static readonly StringBuilder Output = new StringBuilder();
    private static int position;

    private static void Check(bool ok, string action) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), action); }
    private static void Send(IntPtr input, string keys)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(keys);
        int written;
        Check(WriteFile(input, bytes, bytes.Length, out written, IntPtr.Zero) && written == bytes.Length, "write input");
    }
    // conhost 重绘会在文本之间插入 SGR 颜色码；匹配前剥离，位置按剥离后的缓冲计
    private static string Buffer()
    {
        lock (Sync) return Regex.Replace(Output.ToString(), "\x1B\\[[0-9;]*m", "");
    }
    private static void WaitFor(string expected, int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            int found = Buffer().IndexOf(expected, position, StringComparison.Ordinal);
            if (found >= 0) { position = found + expected.Length; return; }
            Thread.Sleep(20);
        }
        throw new Exception("Timed out waiting for " + expected);
    }
    private static void WaitFor(Regex expected, string label, int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            Match found = expected.Match(Buffer(), position);
            if (found.Success) { position = found.Index + found.Length; return; }
            Thread.Sleep(20);
        }
        throw new Exception("Timed out waiting for " + label);
    }
    private static void WaitForTitle(string title)
    {
        // conhost 会把标题后的空格填充重编码为 ESC[nX/ESC[nC 等转义；标题到右边框之间允许字面空格或转义
        WaitFor(new Regex(Regex.Escape(title) + "(?:\x1B\\[[0-9;]*[A-Za-z]| )*║"), title, 3000);
    }
    private static void ReadOutput(IntPtr output)
    {
        byte[] bytes = new byte[4096];
        char[] chars = new char[4096];
        Decoder decoder = Encoding.UTF8.GetDecoder();
        int read;
        while (ReadFile(output, bytes, bytes.Length, out read, IntPtr.Zero) && read > 0)
        {
            int count = decoder.GetChars(bytes, 0, read, chars, 0);
            lock (Sync) Output.Append(chars, 0, count);
        }
    }
    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        IntPtr inRead = IntPtr.Zero, inWrite = IntPtr.Zero, outRead = IntPtr.Zero, outWrite = IntPtr.Zero;
        IntPtr console = IntPtr.Zero, attributes = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        try
        {
            if (args.Length != 3) throw new ArgumentException("Expected node executable, fixture path and scenario");
            Check(CreatePipe(out inRead, out inWrite, IntPtr.Zero, 0), "create input pipe");
            Check(CreatePipe(out outRead, out outWrite, IntPtr.Zero, 0), "create output pipe");
            bool narrow = args[2] == "progress-narrow";
            bool small = args[2] == "form" || args[2] == "form-details" || args[2] == "progress" || args[2] == "multiline-result" || narrow;
            int result = CreatePseudoConsole(new Coord { X = (short)(narrow ? 24 : small ? 60 : 120), Y = (short)(small ? 20 : 30) }, inRead, outWrite, 0, out console);
            if (result != 0) Marshal.ThrowExceptionForHR(result);
            CloseHandle(inRead); inRead = IntPtr.Zero;
            CloseHandle(outWrite); outWrite = IntPtr.Zero;
            IntPtr size = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
            attributes = Marshal.AllocHGlobal(size);
            Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size), "initialize attributes");
            Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20016), console, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "set pseudoconsole");
            StartupInfoEx startup = new StartupInfoEx();
            startup.info.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.info.flags = 0x100;
            startup.attributes = attributes;
            StringBuilder command = new StringBuilder("\"" + args[0] + "\" \"" + args[1] + "\" " + args[2]);
            Check(CreateProcessW(args[0], command, IntPtr.Zero, IntPtr.Zero, false, 0x00080000, IntPtr.Zero, null, ref startup, out child), "start fixture");
            Thread reader = new Thread(() => ReadOutput(outRead));
            reader.IsBackground = true;
            reader.Start();

            if (args[2] == "settings")
            {
                WaitFor("请选择：", 3000);
                Send(inWrite, "\r");
                WaitFor("模型配置", 3000);
                WaitFor("附加工具", 3000);
                Send(inWrite, "\x1b[B\r");
                WaitForTitle("模型配置");
                WaitFor("第三方 API", 3000);
                Send(inWrite, "\x1b[B\r");
                WaitForTitle("第三方 API");
                for (int i = 0; i < 7; i++) Send(inWrite, "\x1b[B");
                Send(inWrite, "\r");
                WaitFor("! 请补全连接项", 3000);
                Send(inWrite, "\x1b[200~https://gateway.example.test\x1b[201~");
                WaitFor("https://gateway.example.test", 3000);
                for (int i = 0; i < 7; i++) Send(inWrite, "\x1b[B");
                Send(inWrite, "\r");
                WaitFor("! 请填写密钥", 3000);
                Send(inWrite, "\x1b[200~fixture-settings-key\x1b[201~");
                WaitFor("••••••••••••••••••••", 3000);
                Send(inWrite, "\t");
                Thread.Sleep(100);
                Send(inWrite, "\x1b[200~gateway[1m]\x1b[201~");
                WaitFor("gateway[1m]", 3000);
                for (int i = 0; i < 5; i++) Send(inWrite, "\x1b[B");
                Send(inWrite, "\r");
                WaitForTitle("安装套件 · 当前用户");
                Send(inWrite, "\x1b[B\r");
                WaitForTitle("默认输出语言");
                Send(inWrite, "\x1b[B\r");
                WaitForTitle("安装套件 · 当前用户");
                Send(inWrite, "\x1b[B\r");
                WaitForTitle("输出风格");
                Send(inWrite, "\x1b[B\r");
                WaitForTitle("安装套件 · 当前用户");
                for (int i = 0; i < 6; i++) Send(inWrite, "\x1b[B");
                Send(inWrite, "\r");
                WaitFor("确认安装", 3000);
                Send(inWrite, "\x1b[A\r");
                WaitForTitle("运行结果 · 完成");
                Send(inWrite, "\x1b");
                WaitFor("请选择：", 3000);
                Send(inWrite, "\x1b");
                WaitFor("SETTINGS_DONE", 3000);
            }
            else if (args[2] == "selection")
            {
                WaitFor("请选择：", 3000);
                Send(inWrite, "\r");
                WaitFor("开始安装（0 项）", 3000);
                Send(inWrite, "\r");
                WaitFor("1 项）", 3000);
                Send(inWrite, " ");
                WaitFor("0 项）", 3000);
                Send(inWrite, "a");
                WaitFor("4 项）", 3000);
                Send(inWrite, "a");
                WaitFor("0 项）", 3000);
                Send(inWrite, " ");
                WaitFor("1 项）", 3000);
                Send(inWrite, "\x1b[B ");
                WaitFor("2 项）", 3000);
                Send(inWrite, "\r");
                WaitFor("1 项）", 3000);
                Send(inWrite, "\r");
                WaitFor("2 项）", 3000);
                Send(inWrite, "\x1b[B\r");
                WaitFor("3 项）", 3000);
                Send(inWrite, "\x1b[B\r");
                WaitFor("4 项）", 3000);
                Send(inWrite, "r");
                Thread.Sleep(100);
                Send(inWrite, "\x1b[B\r");
                WaitFor("确认安装", 3000);
                Send(inWrite, "\x1b[A\r");
                WaitForTitle("运行结果 · 完成");
                Send(inWrite, "\x1b");
                WaitFor("请选择：", 3000);
                Send(inWrite, "\x1b");
                WaitFor("SELECTION_DONE", 3000);
            }
            else if (args[2] == "recovery")
            {
                WaitFor("未完成任务", 3000);
                WaitFor("未执行", 3000);
                Send(inWrite, "\x1b[A\r");
                WaitFor("确认安装", 3000);
                Send(inWrite, "\x1b");
                WaitFor("未完成任务", 3000);
                Send(inWrite, "\x1b[A\r");
                WaitFor("确认安装", 3000);
                Send(inWrite, "\x1b[A\r");
                WaitForTitle("运行结果 · 完成");
                Send(inWrite, "\x1b");
                WaitFor("请选择：", 3000);
                Send(inWrite, "\x1b");
                WaitFor("RECOVERY_DONE", 3000);
            }
            else if (args[2] == "recovery-unknown")
            {
                WaitFor("待核对", 3000);
                Send(inWrite, "\r");
                Thread.Sleep(200);
                Send(inWrite, "\x1b[B\x1b[B\r");
                WaitFor("已完成的安装与设置会保留", 3000);
                Send(inWrite, "\x1b[A\r");
                WaitFor("请选择：", 3000);
                Send(inWrite, "\x1b");
                WaitFor("RECOVERY_UNKNOWN_DONE", 3000);
            }
            else if (args[2] == "skills-cancel")
            {
                WaitFor("请选择：", 3000);
                Send(inWrite, "\r");
                WaitFor("开始安装（0 项）", 3000);
                Send(inWrite, " ");
                WaitFor("1 项）", 3000);
                Send(inWrite, "\x1b[B\r");
                WaitFor("获取技能：HIT-SudoMaker/SSRE2", 3000);
                Send(inWrite, "\x1b");
                WaitFor("[x] HIT-SudoMaker/SSRE2", 3000);
                Send(inWrite, "\x1b");
                WaitFor("请选择：", 3000);
                Send(inWrite, "\x1b");
                WaitFor("SKILLS_CANCEL_DONE", 3000);
            }
            else if (args[2] == "uninstall" || args[2] == "uninstall-data")
            {
                bool removeData = args[2] == "uninstall-data";
                WaitFor("请选择：", 3000);
                Send(inWrite, "\x1b[B\x1b[B\r");
                WaitFor("预览 0 项变更", 3000);
                if (removeData)
                {
                    Send(inWrite, " ");
                    WaitFor("Claude 用户数据", 3000);
                    Send(inWrite, "\x1b[B\x1b[B ");
                    WaitFor("2 项变更", 3000);
                    Send(inWrite, "\x1b[B\r");
                }
                else
                {
                    Send(inWrite, "\x1b[B\r");
                    WaitFor("取消选择", 3000);
                    Send(inWrite, "\x1b[A\x1b[A\r");
                    WaitFor("仅解除接入", 3000);
                    Send(inWrite, "a");
                    WaitFor("2 项变更", 3000);
                    Send(inWrite, "\x1b[B\x1b[B\r");
                }
                WaitFor("确认卸载", 3000);
                Send(inWrite, "\x1b[A\r");
                WaitForTitle("运行结果 · 完成");
                Send(inWrite, "\x1b");
                WaitFor("请选择：", 3000);
                Send(inWrite, "\x1b");
                WaitFor(removeData ? "UNINSTALL_DATA_DONE" : "UNINSTALL_DONE", 3000);
            }
            else if (args[2] == "cleanup")
            {
                WaitFor("请选择：", 3000);
                Send(inWrite, "\x1b[B\x1b[B\x1b[B\r");
                WaitFor("预览 0 项变更", 3000);
                Send(inWrite, "a");
                WaitFor("5 项变更", 3000);
                for (int i = 0; i < 5; i++) Send(inWrite, "\x1b[B");
                Send(inWrite, "\r");
                WaitFor("确认清理", 3000);
                Send(inWrite, "\x1b");
                WaitForTitle("清理数据 · 当前用户");
                Send(inWrite, "\r");
                WaitFor("确认清理", 3000);
                Send(inWrite, "\x1b[A\r");
                WaitForTitle("运行结果 · 完成");
                Send(inWrite, "\x1b");
                WaitFor("请选择：", 3000);
                Send(inWrite, "\x1b");
                WaitFor("CLEANUP_DONE", 3000);
            }
            else if (args[2] == "brand")
            {
                WaitFor("██████╗", 3000);
                WaitFor("Claude Code Workpack", 3000);
                WaitFor("Designed By AMIRC", 3000);
                WaitFor("当前环境状态", 3000);
                WaitFor("请选择：", 3000);
                Send(inWrite, "\r");
                WaitFor("╔", 3000);
                WaitFor("CCW · 安装套件", 3000);
                Send(inWrite, "\x1b");
                WaitFor("██████╗", 3000);
                WaitFor("请选择：", 3000);
                Send(inWrite, "\x1b[B");
                WaitFor("› 检查套件", 3000);
                Send(inWrite, "\r");
                WaitFor("CCW · 检查套件", 3000);
                for (int i = 0; i < 2; i++)
                {
                    Send(inWrite, "\r");
                    WaitFor("进入安装", 3000);
                    Send(inWrite, "\x1b");
                    WaitFor("检查套件", 3000);
                }
                Send(inWrite, "\x1b");
                WaitFor("请选择：", 3000);
                Send(inWrite, "\x1b");
                WaitFor("BRAND_DONE", 3000);
            }
            else if (args[2] == "form-details")
            {
                WaitFor("CCW · DETAIL_FORM", 5000);
                // 空值提交：短提示 + 焦点定位字段；粘贴无效草稿后再提交出第二个问题
                Send(inWrite, "\x1b[B\r");
                WaitFor("! 请填写地址", 3000);
                Send(inWrite, "\x1b[200~fixture-draft\x1b[201~");
                WaitFor("fixture-draft", 3000);
                Send(inWrite, "\x1b[B\r");
                WaitFor("! 地址无效", 3000);
                // 打开「查看详情」进入填写说明；PgDn 翻到末页（Frame 钳制），PgUp 回首页
                Send(inWrite, "\x1b[B\x1b[B\x1b[B\r");
                // conhost 增量重绘会把「CCW · 」前缀与标题分段写出，锚点用标题本身
                WaitFor("填写说明", 3000);
                for (int i = 0; i < 5; i++) Send(inWrite, "\x1b[6~");
                WaitFor("DETAIL_LAST_LINE_12", 3000);
                WaitFor("8–12/12", 3000);
                for (int i = 0; i < 5; i++) Send(inWrite, "\x1b[5~");
                WaitFor("保存配置失败：地址需使用 HTTP 或 HTTPS", 3000);
                // Enter 返回表单：焦点仍在查看详情，无效草稿保留；清空改写为有效值后提交
                Send(inWrite, "\r");
                // 同一重绘帧内草稿行先于焦点行写出，等待顺序与帧序一致
                WaitFor("fixture-draft", 3000);
                WaitFor("› 查看详情", 3000);
                Send(inWrite, "\x1b[A\x1b[A\x1b[A");
                Send(inWrite, "\x15");
                Thread.Sleep(100);
                Send(inWrite, "\x1b[200~https://fixture.example\x1b[201~");
                WaitFor("https://fixture.example", 3000);
                Send(inWrite, "\x1b[B\r");
                WaitFor("FORM_DETAILS_DONE", 5000);
            }
            else if (args[2] == "form")
            {
                WaitFor("FORM_INPUT", 5000);
                Send(inWrite, "\x1b[D中\x1b[3~");
                Send(inWrite, "\x1b[B\r");
                WaitFor("SECRET_INPUT", 5000);
                Send(inWrite, "\x1b[200~fixture-secret\x1b[201~");
                WaitFor("••••••••••••••", 5000);
                Send(inWrite, "\x1b[B\r");
                WaitFor("BATCH_SELECT", 5000);
                Send(inWrite, " "); Thread.Sleep(100);
                Send(inWrite, "a"); Thread.Sleep(100);
                Send(inWrite, " "); Thread.Sleep(100);
                for (int i = 0; i < 40; i++) Send(inWrite, "\x1b[B");
                Send(inWrite, "\r");
                WaitFor("LONG_PREVIEW", 5000);
                for (int i = 0; i < 10; i++) Send(inWrite, "\x1b[6~");
                WaitFor("47–51/51", 5000);
                Send(inWrite, "\x1b");
                WaitFor("FORM_DONE", 5000);
                lock (Sync) if (Output.ToString().Contains("fixture-secret")) throw new Exception("Secret leaked");
            }
            else if (args[2] == "progress" || args[2] == "progress-narrow")
            {
                WaitFor(narrow ? "PROGRESS_STA" : "PROGRESS_START", 3000);
                Send(inWrite, "\r");
                WaitFor("执行进度", 3000);
                WaitFor("Entry 24", 3000);
                for (int i = 0; i < 3; i++) Send(inWrite, "\x1b[5~");
                WaitFor("Entry 01", 1500);
                WaitFor("Entry 02", 1500);
                Send(inWrite, "\x1b[F");
                WaitFor(narrow ? "运行结果" : "运行结果 · 部分完成", 5000);
                if (!narrow) WaitFor("已停止 1", 5000);
                for (int i = 0; i < 3; i++) Send(inWrite, "\x1b[6~");
                WaitFor("Entry 24", 5000);
                Send(inWrite, "\r");
                WaitFor(narrow ? "PROGRESS_NARROW_DONE" : "PROGRESS_DONE", 3000);
            }
            else if (args[2] == "multiline-result")
            {
                WaitForTitle("结果详情");
                WaitFor("PROGRAM MULTILINE", 3000);
                WaitFor("RESULT_RETURN", 3000);
                for (int i = 0; i < 8; i++) Send(inWrite, "\x1b[6~");
                WaitFor("LAST_COPY_30", 3000);
                WaitFor("代码：", 3000);
                Send(inWrite, "\r");
                WaitFor("MULTILINE_RESULT_DONE", 3000);
            }
            else if (args[2] == "handoff")
            {
                WaitFor("HANDOFF_START", 5000);
                Send(inWrite, "\r");
                WaitFor("CHILD_READY", 5000);
                Send(inWrite, "hello\r");
                WaitFor("CHILD_OK", 5000);
                WaitFor("AFTER_CHILD", 5000);
                Send(inWrite, "\x1b[B\r");
                WaitFor("HANDOFF_DONE", 5000);
            }
            else if (args[2] == "cancel")
            {
                WaitFor("CANCEL_READY", 5000);
                Send(inWrite, "\x03");
                WaitFor("RAW_RESTORED", 5000);
            }
            else if (args[2] == "waiting")
            {
                WaitFor("WAIT_READY", 3000);
                Send(inWrite, "\x1b");
                WaitFor("AFTER_WAIT", 1500);
                Send(inWrite, "\x1b[B\r");
                WaitFor("WAIT_DONE", 3000);
            }
            else if (args[2] == "render")
            {
                WaitFor("RENDER_READY", 3000);
                for (int i = 0; i < 10; i++) Send(inWrite, "\x1b[B");
                Send(inWrite, "\r");
                WaitFor("RENDER_DONE", 3000);
            }
            else throw new ArgumentException("Unknown scenario");
            if (WaitForSingleObject(child.process, 5000) != 0) throw new Exception("Fixture did not exit");
            int exitCode;
            Check(GetExitCodeProcess(child.process, out exitCode), "read fixture exit status");
            if (exitCode != (args[2] == "cancel" ? 130 : 0)) throw new Exception("Fixture exited with code " + exitCode);
            Console.WriteLine("PASS: " + args[2]);
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("FAIL: " + error.Message);
            Console.Error.WriteLine(Output.ToString());
            return 1;
        }
        finally
        {
            if (child.process != IntPtr.Zero)
            {
                if (WaitForSingleObject(child.process, 0) != 0) TerminateProcess(child.process, 1);
                CloseHandle(child.process);
            }
            if (child.thread != IntPtr.Zero) CloseHandle(child.thread);
            if (console != IntPtr.Zero) ClosePseudoConsole(console);
            if (attributes != IntPtr.Zero) { DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
            if (inRead != IntPtr.Zero) CloseHandle(inRead);
            if (inWrite != IntPtr.Zero) CloseHandle(inWrite);
            if (outRead != IntPtr.Zero) CloseHandle(outRead);
            if (outWrite != IntPtr.Zero) CloseHandle(outWrite);
        }
    }
}
