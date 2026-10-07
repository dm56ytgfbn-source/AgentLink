import {watchFile,unwatchFile,readFileSync} from 'node:fs';
import {validateConfig,type Config} from '../node/server.js';

// Reload only the opt-in input settings. Network identity, roots and permissions are immutable.
// A local settings edit takes effect without restarting the service or its other tasks.
export function watchInputShareConfig(file:string,config:Config,interval=1000){
 const changed=()=>{
  try{
   const candidate={...config,input_share:JSON.parse(readFileSync(file,'utf8')).input_share};
   validateConfig(candidate);
   config.input_share=candidate.input_share;
  }catch{config.input_share=undefined;} // Invalid settings fail closed.
 };
 watchFile(file,{interval,persistent:false},changed);
 return ()=>unwatchFile(file,changed);
}
