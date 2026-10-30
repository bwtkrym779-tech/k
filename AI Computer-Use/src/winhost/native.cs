using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

namespace WinAgent
{
    public static class Native
    {
        // ---------- DPI ----------
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

        // ---------- Window enumeration ----------
        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int Left, Top, Right, Bottom; }

        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT rect, int size);

        [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint threadId);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
        [DllImport("user32.dll")] public static extern bool SetFocus(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern IntPtr GetFocus();
        [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);

        // ---------- Screen metrics ----------
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

        public const int SM_XVIRTUALSCREEN = 76;
        public const int SM_YVIRTUALSCREEN = 77;
        public const int SM_CXVIRTUALSCREEN = 78;
        public const int SM_CYVIRTUALSCREEN = 79;

        // ---------- Input ----------
        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo;
        }
        [StructLayout(LayoutKind.Explicit)]
        public struct INPUTUNION
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
        }
        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type; public INPUTUNION u;
        }

        public const uint INPUT_MOUSE = 0;
        public const uint INPUT_KEYBOARD = 1;

        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;
        public const uint KEYEVENTF_SCANCODE = 0x0008;

        public const uint MOUSEEVENTF_MOVE = 0x0001;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint MOUSEEVENTF_HWHEEL = 0x0100;
        public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
        public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

        [DllImport("user32.dll", SetLastError = true)]
        public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
        [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
        [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, UIntPtr extra);

        public const int VK_CONTROL = 0x11, VK_MENU = 0x12, VK_SHIFT = 0x10, VK_LWIN = 0x5B, VK_RWIN = 0x5C;

        public static int[] VirtualScreen()
        {
            int x = GetSystemMetrics(SM_XVIRTUALSCREEN);
            int y = GetSystemMetrics(SM_YVIRTUALSCREEN);
            int w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
            int h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
            return new int[] { x, y, w, h };
        }

        public static void EnableDpiAwareness()
        {
            try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } // PER_MONITOR_AWARE_V2
            catch { SetProcessDPIAware(); }
        }

        // Absolute mouse move across the virtual desktop (physical pixels).
        public static void MoveAbsolute(int x, int y)
        {
            int[] vs = VirtualScreen();
            if (vs[2] <= 1 || vs[3] <= 1) return;
            double nx = (double)(x - vs[0]) * 65535.0 / (vs[2] - 1);
            double ny = (double)(y - vs[1]) * 65535.0 / (vs[3] - 1);
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].u.mi.dx = (int)Math.Round(Math.Max(0, Math.Min(65535, nx)));
            inputs[0].u.mi.dy = (int)Math.Round(Math.Max(0, Math.Min(65535, ny)));
            inputs[0].u.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
            SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        public static uint MouseButton(string button, bool down)
        {
            uint flag;
            switch (button)
            {
                case "right": flag = down ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_RIGHTUP; break;
                case "middle": flag = down ? MOUSEEVENTF_MIDDLEDOWN : MOUSEEVENTF_MIDDLEUP; break;
                default: flag = down ? MOUSEEVENTF_LEFTDOWN : MOUSEEVENTF_LEFTUP; break;
            }
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].u.mi.dwFlags = flag;
            return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        public static uint Wheel(int delta, bool horizontal)
        {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_MOUSE;
            inputs[0].u.mi.dwFlags = horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL;
            inputs[0].u.mi.mouseData = unchecked((uint)delta);
            return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        public static uint Key(ushort vk, bool up)
        {
            INPUT[] inputs = new INPUT[1];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].u.ki.wVk = vk;
            inputs[0].u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
            return SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        // Send a string as Unicode key events. Handles shotcuts for newline/tab.
        public static uint TypeUnicode(string text)
        {
            List<INPUT> list = new List<INPUT>();
            foreach (char ch in text)
            {
                if (ch == '\r') continue;
                if (ch == '\n')
                {
                    list.Add(MakeVk(0x0D, false)); list.Add(MakeVk(0x0D, true)); continue;
                }
                if (ch == '\t')
                {
                    list.Add(MakeVk(0x09, false)); list.Add(MakeVk(0x09, true)); continue;
                }
                INPUT down = new INPUT(); down.type = INPUT_KEYBOARD;
                down.u.ki.wScan = ch; down.u.ki.wVk = 0; down.u.ki.dwFlags = KEYEVENTF_UNICODE;
                INPUT up = new INPUT(); up.type = INPUT_KEYBOARD;
                up.u.ki.wScan = ch; up.u.ki.wVk = 0; up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
                list.Add(down); list.Add(up);
            }
            if (list.Count == 0) return 0;
            INPUT[] arr = list.ToArray();
            return SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT)));
        }

        private static INPUT MakeVk(ushort vk, bool up)
        {
            INPUT i = new INPUT();
            i.type = INPUT_KEYBOARD;
            i.u.ki.wVk = vk;
            i.u.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
            return i;
        }

        // Return visible top-level windows.
        public static List<IntPtr> TopLevelWindows()
        {
            List<IntPtr> result = new List<IntPtr>();
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (IsWindowVisible(h) && GetWindowTextLength(h) > 0) result.Add(h);
                return true;
            }, IntPtr.Zero);
            return result;
        }

        public static string Title(IntPtr h)
        {
            int len = GetWindowTextLength(h);
            StringBuilder sb = new StringBuilder(Math.Max(len + 1, 256));
            GetWindowText(h, sb, sb.Capacity);
            return sb.ToString();
        }

        public static string ClassName(IntPtr h)
        {
            StringBuilder sb = new StringBuilder(256);
            GetClassName(h, sb, sb.Capacity);
            return sb.ToString();
        }

        // Physical-pixel window bounds without the invisible resize border when possible.
        public static int[] WindowRect(IntPtr h)
        {
            RECT r;
            try
            {
                if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0)
                    return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
            }
            catch { }
            if (GetWindowRect(h, out r)) return new int[] { r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top };
            return new int[] { 0, 0, 0, 0 };
        }

        public static bool Focus(IntPtr h)
        {
            if (!IsWindow(h)) return false;
            if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
            if (GetForegroundWindow() == h) return true;

            uint current = GetCurrentThreadId();
            uint pid;
            uint target = GetWindowThreadProcessId(h, out pid);
            AttachThreadInput(current, target, true);
            try
            {
                BringWindowToTop(h);
                SwitchToThisWindow(h, true);
                SetForegroundWindow(h);
                SetFocus(h);
            }
            finally { AttachThreadInput(current, target, false); }
            if (GetForegroundWindow() == h) return true;

            // Windows blocks SetForegroundWindow for processes that did not
            // receive the last input event. A synthetic ALT keypress makes this
            // thread eligible, which is the standard way automation obtains focus.
            keybd_event(0x12, 0, 0, UIntPtr.Zero);   // ALT down
            keybd_event(0x12, 0, 2, UIntPtr.Zero);   // ALT up
            ShowWindow(h, 5);                        // SW_SHOW
            SetForegroundWindow(h);
            if (GetForegroundWindow() == h) return true;

            // Last resort: minimize/restore, which makes the window the most
            // recently activated one on this desktop.
            ShowWindowAsync(h, 6); // SW_MINIMIZE
            System.Threading.Thread.Sleep(120);
            ShowWindowAsync(h, 9); // SW_RESTORE
            System.Threading.Thread.Sleep(80);
            SetForegroundWindow(h);

            for (int i = 0; i < 12; i++)
            {
                if (GetForegroundWindow() == h) return true;
                System.Threading.Thread.Sleep(40);
                SetForegroundWindow(h);
            }
            return GetForegroundWindow() == h;
        }

        public static bool Close(IntPtr h) { return PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); } // WM_CLOSE
    }
}
