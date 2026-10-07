using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Diagnostics;
using System.Text;

// .NET Framework built-in compiler; dedicated hook/message thread and queued stdout.
class AgentLinkInput {
 const ulong Tag=0x41474C4B;
 [StructLayout(LayoutKind.Sequential)] struct Point {public int x,y;}
 [StructLayout(LayoutKind.Sequential)] struct MouseHook {public Point pt;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] struct KeyHook {public uint vk,scan,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] struct MouseInput {public int dx,dy;public uint data,flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] struct KeyInput {public ushort vk,scan;public uint flags,time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] struct InputUnion {[FieldOffset(0)]public MouseInput mouse;[FieldOffset(0)]public KeyInput key;}
 [StructLayout(LayoutKind.Sequential)] struct Input {public uint type;public InputUnion u;}
 delegate IntPtr Hook(int code,IntPtr message,IntPtr data);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id,Hook callback,IntPtr module,uint thread);
 [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
 [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
 [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
 [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
 [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
 [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code,uint type);
 [DllImport("user32.dll")] static extern uint SendInput(uint count,Input[] inputs,int size);
 [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj,int index,StringBuilder info,uint length,out uint needed);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
 static readonly JavaScriptSerializer json=new JavaScriptSerializer();
 static readonly BlockingCollection<string> outgoing=new BlockingCollection<string>(512);
 static readonly HashSet<int> physicalKeys=new HashSet<int>(),physicalButtons=new HashSet<int>(),keys=new HashSet<int>(),buttons=new HashSet<int>();
 static readonly Stopwatch clock=Stopwatch.StartNew();
 static Hook mouseDelegate=Mouse, keyDelegate=Keyboard;
 static IntPtr mouseHook,keyHook;
 static SynchronizationContext context;
 static string mode="local",initialDisplays;
 static int epoch=0;
 static long heartbeat=0;
 static bool stopped=false;
 static Point cursor,anchor,previous;
 static double wheelX=0,wheelY=0;
 static object Obj(params object[] args){var d=new Dictionary<string,object>();for(int i=0;i<args.Length;i+=2)d[(string)args[i]]=args[i+1];return d;}
 static void Emit(object value){if(!outgoing.TryAdd(json.Serialize(value)))Stop("output-backpressure");}
 static object Displays(){var a=new List<object>();foreach(var s in Screen.AllScreens)a.Add(Obj("id",s.DeviceName,"x",s.Bounds.X,"y",s.Bounds.Y,"width",s.Bounds.Width,"height",s.Bounds.Height));return a;}
 static void Event(object e){Emit(Obj("t","event","epoch",epoch,"e",e));}
 static bool DesktopSafe(){IntPtr d=OpenInputDesktop(0,false,1);if(d==IntPtr.Zero)return false;try{uint n;var b=new StringBuilder(256);return GetUserObjectInformation(d,2,b,512,out n)&&b.ToString()=="Default";}finally{CloseDesktop(d);}}
 static void Inject(Input i){if(SendInput(1,new Input[]{i},Marshal.SizeOf(typeof(Input)))!=1&&!stopped)Stop("SendInput-failed-or-UIPI");}
 static void MouseInputEvent(uint flags,uint data,int dx,int dy){var i=new Input();i.type=0;i.u.mouse=new MouseInput{dx=dx,dy=dy,data=data,flags=flags,extra=new UIntPtr(Tag)};Inject(i);}
 static void Move(int x,int y){cursor=new Point{x=x,y=y};var r=SystemInformation.VirtualScreen;int dx=(int)Math.Round((x-r.Left)*65535.0/Math.Max(1,r.Width-1));int dy=(int)Math.Round((y-r.Top)*65535.0/Math.Max(1,r.Height-1));MouseInputEvent(0xC001,0,dx,dy);}
 static void Key(int code,bool down){if(down)keys.Add(code);else keys.Remove(code);var i=new Input();i.type=1;i.u.key=new KeyInput{scan=(ushort)(code&255),flags=(uint)(8|((code&256)!=0?1:0)|(down?0:2)),extra=new UIntPtr(Tag)};Inject(i);}
 static void Button(int b,bool down){if(down)buttons.Add(b);else buttons.Remove(b);uint flag=b==0?(down?2u:4u):b==1?(down?8u:16u):b==2?(down?32u:64u):(down?128u:256u);MouseInputEvent(flag,b>=3?(uint)(b-2):0,0,0);}
 static void Release(){foreach(int k in new List<int>(keys))Key(k,false);foreach(int b in new List<int>(buttons))Button(b,false);wheelX=wheelY=0;}
 static void Stop(string reason){if(stopped)return;stopped=true;mode="local";Release();if(mouseHook!=IntPtr.Zero)UnhookWindowsHookEx(mouseHook);if(keyHook!=IntPtr.Zero)UnhookWindowsHookEx(keyHook);outgoing.TryAdd(json.Serialize(Obj("t","panic","reason",reason)));outgoing.CompleteAdding();Application.ExitThread();}
 static IntPtr Mouse(int n,IntPtr message,IntPtr ptr){if(n<0)return CallNextHookEx(mouseHook,n,message,ptr);var h=(MouseHook)Marshal.PtrToStructure(ptr,typeof(MouseHook));if((h.flags&1)!=0)return CallNextHookEx(mouseHook,n,message,ptr);
  int m=message.ToInt32();object e=null;
  if(m==0x200){int dx=h.pt.x-(mode=="remote"?anchor.x:previous.x),dy=h.pt.y-(mode=="remote"?anchor.y:previous.y);previous=h.pt;e=Obj("kind","move","x",h.pt.x,"y",h.pt.y,"dx",dx,"dy",dy,"held",physicalKeys.Count+physicalButtons.Count);}
  else if(m==0x20A||m==0x20E){double delta=(short)(h.data>>16)/120.0*40;e=Obj("kind","scroll","dx",m==0x20E?delta:0,"dy",m==0x20A?delta:0);}
  else {int b=-1;bool down=false;switch(m){case 0x201:b=0;down=true;break;case 0x202:b=0;break;case 0x204:b=1;down=true;break;case 0x205:b=1;break;case 0x207:b=2;down=true;break;case 0x208:b=2;break;case 0x20B:b=(int)(h.data>>16)+2;down=true;break;case 0x20C:b=(int)(h.data>>16)+2;break;}if(b>=0){if(down)physicalButtons.Add(b);else physicalButtons.Remove(b);e=Obj("kind","button","button",b,"down",down);}}
  if(e!=null)Event(e);return mode=="remote"?new IntPtr(1):CallNextHookEx(mouseHook,n,message,ptr);
 }
 static IntPtr Keyboard(int n,IntPtr message,IntPtr ptr){if(n<0)return CallNextHookEx(keyHook,n,message,ptr);var h=(KeyHook)Marshal.PtrToStructure(ptr,typeof(KeyHook));if((h.flags&16)!=0)return CallNextHookEx(keyHook,n,message,ptr);
  int code=(int)h.scan+((h.flags&1)!=0?256:0);bool down=(h.flags&128)==0;if(down)physicalKeys.Add(code);else physicalKeys.Remove(code);
  if(code==1&&down&&(physicalKeys.Contains(29)||physicalKeys.Contains(285))&&(physicalKeys.Contains(56)||physicalKeys.Contains(312))){Stop("emergency-hotkey");return new IntPtr(1);}
  Event(Obj("kind","key","code",code,"down",down));return mode=="remote"?new IntPtr(1):CallNextHookEx(keyHook,n,message,ptr);
 }
 static double Num(Dictionary<string,object> d,string k){return Convert.ToDouble(d[k]);}
 static void Command(Dictionary<string,object> c){if(stopped)return;string t=(string)c["t"];if(t=="ping"){heartbeat=clock.ElapsedMilliseconds;return;}if(t=="stop"){Stop("stopped");return;}int n=Convert.ToInt32(c["epoch"]);if(n<epoch)return;
  if(t=="mode"){string m=(string)c["mode"];if(m!="local"&&m!="remote"&&m!="receive")throw new Exception("Bad mode");if(m=="remote"&&(physicalKeys.Count>0||physicalButtons.Count>0)){Stop("input-held-during-switch");return;}Release();epoch=n;mode=m;
   if(c.ContainsKey("point")){var p=(Dictionary<string,object>)c["point"];Move((int)Num(p,"x"),(int)Num(p,"y"));}
   if(m=="remote"){Point p;GetCursorPos(out p);var s=Screen.FromPoint(new System.Drawing.Point(p.x,p.y)).Bounds;anchor=new Point{x=s.X+s.Width/2,y=s.Y+s.Height/2};Move(anchor.x,anchor.y);previous=anchor;}
   else GetCursorPos(out previous);
   Emit(Obj("t","ack","epoch",epoch));return;
  }
  if(n!=epoch||mode!="receive")return;var e=(Dictionary<string,object>)c["e"];string kind=(string)e["kind"];
  if(kind=="move")Move((int)Num(e,"x"),(int)Num(e,"y"));
  else if(kind=="key")Key((int)Num(e,"code"),(bool)e["down"]);
  else if(kind=="button")Button((int)Num(e,"button"),(bool)e["down"]);
  else if(kind=="scroll"){wheelX+=Num(e,"dx")*3;wheelY+=Num(e,"dy")*3;int x=(int)wheelX,y=(int)wheelY;wheelX-=x;wheelY-=y;if(x!=0)MouseInputEvent(0x1000,unchecked((uint)x),0,0);if(y!=0)MouseInputEvent(0x800,unchecked((uint)y),0,0);}
 }
 [STAThread] static void Main(string[] args){Mutex captureOwner=null;bool ownsCapture=false;try{
  try{SetProcessDpiAwarenessContext(new IntPtr(-4));}catch(EntryPointNotFoundException){Console.Error.WriteLine("Windows 10 1703 or later required");Environment.Exit(2);}
  if(Array.IndexOf(args,"--inspect")>=0){Console.WriteLine(json.Serialize(Obj("t","ready","permissions",DesktopSafe(),"displays",Displays())));return;}
  captureOwner=new Mutex(false,@"Local\AgentLinkInputCapture");
  try{ownsCapture=captureOwner.WaitOne(0);}catch(AbandonedMutexException){ownsCapture=true;}
  if(!ownsCapture){Console.WriteLine(json.Serialize(Obj("t","panic","reason","input-sharing-already-active")));Environment.ExitCode=2;return;}
  if(!DesktopSafe()){Console.Error.WriteLine("An unlocked interactive desktop is required");Environment.Exit(2);}
  var writer=new Thread(delegate(){foreach(var line in outgoing.GetConsumingEnumerable()){Console.WriteLine(line);Console.Out.Flush();}});writer.IsBackground=true;writer.Start();
  for(int vk=8;vk<256;vk++){if(vk==16||vk==17||vk==18)continue;if((GetAsyncKeyState(vk)&0x8000)!=0){uint scan=MapVirtualKey((uint)vk,4);if(scan!=0)physicalKeys.Add((int)(scan&255)+((scan&0xFF00)==0xE000?256:0));}}
  int[] mouseVK={1,2,4,5,6};for(int i=0;i<mouseVK.Length;i++)if((GetAsyncKeyState(mouseVK[i])&0x8000)!=0)physicalButtons.Add(i);
  context=new WindowsFormsSynchronizationContext();SynchronizationContext.SetSynchronizationContext(context);GetCursorPos(out previous);initialDisplays=json.Serialize(Displays());
  mouseHook=SetWindowsHookEx(14,mouseDelegate,GetModuleHandle(null),0);keyHook=SetWindowsHookEx(13,keyDelegate,GetModuleHandle(null),0);
  if(mouseHook==IntPtr.Zero||keyHook==IntPtr.Zero)throw new Exception("Cannot install input hooks");
  heartbeat=clock.ElapsedMilliseconds;
  var reader=new Thread(delegate(){try{string line;while((line=Console.ReadLine())!=null){if(line.Length>16384)throw new Exception("Oversize command");var c=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(line);context.Post(delegate(object unused){try{Command(c);}catch{Stop("invalid-command");}},null);}context.Post(delegate(object unused){Stop("controller-exited");},null);}catch{context.Post(delegate(object unused){Stop("invalid-command");},null);}});reader.IsBackground=true;reader.Start();
  var timer=new System.Windows.Forms.Timer();timer.Interval=200;timer.Tick+=delegate{
   if(clock.ElapsedMilliseconds-heartbeat>1500)Stop("controller-timeout");
   if(!DesktopSafe())Stop("desktop-locked-or-secure");
   if(initialDisplays!=json.Serialize(Displays()))Stop("display-layout-changed");
  };timer.Start();
  Emit(Obj("t","ready","permissions",true,"displays",Displays()));Application.Run();writer.Join(500);
 }catch(Exception e){Console.Error.WriteLine(e.Message);Stop("native-error");Environment.ExitCode=2;}finally{if(ownsCapture)captureOwner.ReleaseMutex();if(captureOwner!=null)captureOwner.Dispose();}}
}
