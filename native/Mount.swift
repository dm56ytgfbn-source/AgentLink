import Foundation
import NetFS
let input=FileHandle.standardInput.readDataToEndOfFile()
do {
 guard let p=try JSONSerialization.jsonObject(with:input) as? [String:Any],let secret=p["password"] as? String,let mount=p["mount"] as? String,let port=p["port"] as? Int,port>0,port<65536 else {throw NSError(domain:"AgentLink",code:1)}
 var points:Unmanaged<CFArray>?
 let openDict=NSMutableDictionary(dictionary:["UIOption":"NoUI","AllowLoopback":true]); let open=unsafeBitCast(openDict,to:CFMutableDictionary.self)
 let mountDict=NSMutableDictionary(dictionary:["MountAtMountDir":true,"SoftMount":true]); let options=unsafeBitCast(mountDict,to:CFMutableDictionary.self)
 let result=NetFSMountURLSync(URL(string:"http://127.0.0.1:\(port)/")! as CFURL,URL(fileURLWithPath:mount) as CFURL,"agentlink" as CFString,secret as CFString,open,options,&points)
 print("Mount status: \(result)")
 if let points=points {print(points.takeRetainedValue())}
 exit(result==0 ? 0 : 1)
}catch{fputs("Invalid mount input\n",stderr);exit(1)}
