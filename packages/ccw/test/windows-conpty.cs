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
            int result = CreatePseudoConsole(new Coord { X = (short)(args[2] == "narrow" ? 40 : 120), Y = (short)(args[2] == "narrow" ? 16 : 30) }, inRead, outWrite, 0, out console);
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


            if(args[2]=="home") {
              WaitFor("██████",5000);
              WaitFor("Designed By AMIRC",5000);
              WaitFor("当前环境状态",5000);
              WaitFor("安装配置",5000);
              Send(inWrite,"\x1b[B\r");
              WaitFor("返回主菜单",5000);
              Send(inWrite,"\r");
              WaitFor("安装配置",5000);
              Send(inWrite,"\x1b");
              WaitFor("HOME_DONE",5000);
            } else if(args[2]=="narrow") {
              WaitFor("Claude Code Workpack",5000);
              WaitFor("安装配置",5000);
              Send(inWrite,"\x1b"); WaitFor("NARROW_DONE",5000);
            } else if(args[2]=="inspection") {
              WaitFor("FIRST_ENTRY",5000);
              if(Buffer().Contains("LAST_ENTRY")) throw new Exception("Inspection did not paginate");
              Send(inWrite,"\x1b[6~\x1b[6~\x1b[6~\x1b[6~"); WaitFor("LAST_ENTRY",5000);
              Send(inWrite,"\x1b[5~\x1b[5~\x1b[5~\x1b[5~"); WaitFor("FIRST_ENTRY",5000);
              Send(inWrite,"\r"); WaitFor("INSPECTION_DONE",5000);
            } else if(args[2]=="selection") {
              foreach(string group in new [] { "── 基础配置", "── Plugins", "── Skills", "── 附加工具" }) WaitFor(group,5000);
              WaitFor("EMPTY",5000);
              Send(inWrite," "); WaitFor("SINGLE",5000);
              Send(inWrite,"a"); WaitFor("ALL",5000);
              for(int i=0;i<7;i++) Send(inWrite,"\x1b[B");
              Send(inWrite,"\r"); WaitFor("SELECTION_DONE",5000);
            } else if(args[2]=="settings") {
              WaitFor("安装配置",5000); Send(inWrite,"\r");
              WaitFor("默认语言",5000); WaitFor("输出风格",5000);
              Send(inWrite,"\x1b[B\r"); WaitFor("英文",5000);
              Send(inWrite,"\x1b[B\r"); Thread.Sleep(150);
              Send(inWrite,"\x1b[B\x1b[B\r"); WaitFor("确认安装",5000);
              Send(inWrite,"\x1b"); WaitFor("输出风格",5000);
              Send(inWrite,"\x1b"); WaitFor("退出程序",5000);
              Send(inWrite,"\x1b"); WaitFor("SETTINGS_DONE",5000);
            } else if(args[2]=="form") {
              WaitFor("FORM_INPUT",5000);
              Send(inWrite,"\x1b[B\r"); WaitFor("NAME_REQUIRED",5000);
              Send(inWrite,"\x1b[200~中文 name\x1b[201~"); WaitFor("中文 name",5000);
              Send(inWrite,"\t"); Thread.Sleep(100);
              Send(inWrite,"\x1b[200~private-token\x1b[201~"); WaitFor("•••••••••••••",5000);
              Send(inWrite,"\r"); WaitFor("FORM_DONE",5000);
              if(Buffer().Contains("private-token")) throw new Exception("Secret echoed");
            } else if(args[2]=="handoff") {
              WaitFor("HANDOFF_START",5000); Send(inWrite,"\r");
              WaitFor("CHILD_READY",5000); Send(inWrite,"hello\r");
              WaitFor("CHILD_OK",5000); WaitFor("AFTER_CHILD",5000);
              Send(inWrite,"\x1b[B\r"); WaitFor("HANDOFF_DONE",5000);
            } else if(args[2]=="cancel") {
              WaitFor("CANCEL_READY",5000); Send(inWrite,"\x03"); WaitFor("RAW_RESTORED",5000);
            } else if(args[2]=="waiting") {
              WaitFor("WAIT_READY",5000); Send(inWrite,"\x1b"); WaitFor("AFTER_WAIT",5000);
              Send(inWrite,"\x1b[B\r"); WaitFor("WAIT_DONE",5000);
            } else throw new ArgumentException("Unknown scenario");
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
