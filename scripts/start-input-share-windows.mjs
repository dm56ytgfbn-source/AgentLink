import {ensureWindowsInputHelper} from './windows-input-helper.mjs';
// Keep the controller in this process: its stdin is owned by the desktop app.
// Closing the app pipe stops input capture, rather than leaving an orphan session.
try{
 const helper=await ensureWindowsInputHelper();
 process.argv.push('--helper',helper,'--enable','--control-stdin');
 await import('../dist/apps/input-share/main.js');
}catch(error){console.error(error.message);process.exitCode=1;}
