import http from "node:http";
import { createHash, createHmac, timingSafeEqual, randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdir, realpath, statfs, readFile, writeFile, rm, readdir, lstat, open, rename, cp } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { resolve, sep, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import Docker from "dockerode";
import { Server as SSHServer } from "ssh2";

const execFileAsync=promisify(execFile);
const PORT=Number(process.env.PORT||8788);
const SECRET=process.env.HOSTPILOT_AGENT_SECRET||"";
const PROJECT_ROOT=resolve(process.env.PROJECT_ROOT||"/srv/hostpilot/projects");
const DOCKER_SOCKET=process.env.DOCKER_SOCKET||process.env.DOCKER_HOST||"/run/user/1000/docker.sock";
const docker=new Docker(DOCKER_SOCKET.startsWith("unix://")?{socketPath:DOCKER_SOCKET.slice(7)}:{socketPath:DOCKER_SOCKET});
const seen=new Map<string,number>();
const versions:Record<string,string>={
 "python:3.11":"python:3.11-slim","python:3.12":"python:3.12-slim","python:3.13":"python:3.13-slim",
 "nodejs:20":"node:20-bookworm-slim","nodejs:22":"node:22-bookworm-slim","nodejs:24":"node:24-bookworm-slim"
};
function reply(res:http.ServerResponse,status:number,data:unknown){res.writeHead(status,{"content-type":"application/json","cache-control":"no-store"});res.end(JSON.stringify(data));}
async function readBody(req:http.IncomingMessage):Promise<string>{let raw="";for await(const chunk of req) {raw+=chunk.toString();if(raw.length>120000)throw new Error("BODY_TOO_LARGE");}return raw;}
function verify(req:http.IncomingMessage,raw:string):boolean{
 if(!SECRET)return false;
 const ts=req.headers["x-hostpilot-timestamp"],nonce=req.headers["x-hostpilot-nonce"],signature=req.headers["x-hostpilot-signature"];
 if(typeof ts!=="string"||typeof nonce!=="string"||typeof signature!=="string"||!/^[0-9]{10}$/.test(ts)||!/^[a-f0-9-]{24,64}$/i.test(nonce))return false;
 const timestamp=Number(ts);if(Math.abs(Date.now()/1000-timestamp)>60||seen.has(nonce))return false;
 const bodyHash=createHash("sha256").update(raw).digest("hex");
 const path=req.url||"/";const expected=createHmac("sha256",SECRET).update([ts,nonce,req.method||"GET",path,bodyHash].join("\n")).digest();
 let supplied:Buffer;try{supplied=Buffer.from(signature,"hex");}catch{return false;}
 if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return false;
 seen.set(nonce,Date.now()+120000);for(const [key,expiry] of seen)if(expiry<Date.now())seen.delete(key);
 return true;
}
function safeId(value:string){if(!/^[a-f0-9-]{36}$/i.test(value))throw new Error("INVALID_PROJECT_ID");return value;}
async function projectDirectory(id:string){const target=resolve(PROJECT_ROOT,id);if(!target.startsWith(PROJECT_ROOT+sep))throw new Error("INVALID_PROJECT_PATH");await mkdir(target,{recursive:true,mode:0o770});const actual=await realpath(target);if(!actual.startsWith(PROJECT_ROOT+sep))throw new Error("INVALID_PROJECT_PATH");return actual;}
async function getContainer(id:string){return docker.getContainer("hp-"+id);}
const server=http.createServer(async(req,res)=>{
 try{
  const raw=await readBody(req);
  if(req.method==="GET"&&req.url==="/health"){reply(res,200,{ok:true,agent:"hostpilot-node-agent"});return;}
  if(!verify(req,raw)){reply(res,401,{error:"INVALID_AGENT_SIGNATURE"});return;}
  const match=(req.url||"").match(/^\/v1\/projects\/([a-f0-9-]{36})\/(start|stop|restart|delete|status|logs|file_list|file_read|file_write|file_delete|file_mkdir|backup|restore|backup_delete)$/i);
  if(req.method!=="POST"||!match){reply(res,404,{error:"NOT_FOUND"});return;}
  const id=safeId(match[1]);const action=match[2];const name="hp-"+id;

  if(action==="backup_delete"){
   const input=raw?JSON.parse(raw):{};const backupId=String(input.backup_id||"");
   if(!/^[a-f0-9-]{36}$/i.test(backupId))throw new Error("INVALID_BACKUP_ID");
   const backupRoot=resolve(PROJECT_ROOT,"..","backups",id),archive=resolve(backupRoot,backupId+".tar.gz");
   if(!archive.startsWith(backupRoot+sep))throw new Error("INVALID_BACKUP_PATH");
   try{const st=await lstat(archive);if(st.isSymbolicLink()||!st.isFile())throw new Error("BACKUP_ARCHIVE_INVALID");await rm(archive,{force:true});}
   catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   reply(res,200,{backup_id:backupId,deleted:true});return;
  }
  if(action==="backup"||action==="restore"){
   const input=raw?JSON.parse(raw):{};const backupId=String(input.backup_id||"");
   if(!/^[a-f0-9-]{36}$/i.test(backupId))throw new Error("INVALID_BACKUP_ID");
   const root=await projectDirectory(id),backupRoot=resolve(PROJECT_ROOT,"..","backups",id);
   await mkdir(backupRoot,{recursive:true,mode:0o700});
   const archive=resolve(backupRoot,backupId+".tar.gz");
   if(!archive.startsWith(backupRoot+sep))throw new Error("INVALID_BACKUP_PATH");
   if(action==="backup"){
    await execFileAsync("tar",["--exclude=./.git","--exclude=./node_modules","--exclude=./.venv","--exclude=./__pycache__","-czf",archive,"-C",root,"."],{timeout:600000,maxBuffer:1024*1024});
    const st=await lstat(archive);if(!st.isFile()||st.isSymbolicLink())throw new Error("BACKUP_ARCHIVE_INVALID");
    reply(res,200,{backup_id:backupId,size_bytes:st.size,created:true});return;
   }
   const archiveStat=await lstat(archive);if(!archiveStat.isFile()||archiveStat.isSymbolicLink()||archiveStat.size>1024*1024*1024)throw new Error("BACKUP_NOT_FOUND_OR_TOO_LARGE");
   const listing=await execFileAsync("tar",["-tzf",archive],{timeout:120000,maxBuffer:8*1024*1024});
   const names=listing.stdout.split("\n").filter(Boolean);
   if(!names.length||names.length>10000||names.some(name=>name.startsWith("/")||name.split("/").some(part=>part==="..")))throw new Error("BACKUP_ARCHIVE_PATH_INVALID");
   const staging=resolve(backupRoot,backupId+"-restore");
   await rm(staging,{recursive:true,force:true});await mkdir(staging,{recursive:true,mode:0o700});
   try{
    await execFileAsync("tar",["--no-same-owner","--no-same-permissions","-xzf",archive,"-C",staging],{timeout:600000,maxBuffer:1024*1024});
    let files=0,totalBytes=0;
    const inspect=async(dir:string):Promise<void>=>{for(const entry of await readdir(dir,{withFileTypes:true})){const full=resolve(dir,entry.name);if(entry.isSymbolicLink())throw new Error("BACKUP_SYMLINK_NOT_ALLOWED");if(entry.isDirectory())await inspect(full);else if(entry.isFile()){const st=await lstat(full);files++;totalBytes+=st.size;if(files>10000||totalBytes>1024*1024*1024)throw new Error("BACKUP_RESTORE_LIMIT");}else throw new Error("BACKUP_SPECIAL_FILE_NOT_ALLOWED");}};
    await inspect(staging);
    let container:any=null,wasRunning=false;try{container=await getContainer(id);const info=await container.inspect();wasRunning=!!info.State.Running;if(wasRunning)await container.stop({t:15});}catch{}
    for(const entry of await readdir(root))await rm(resolve(root,entry),{recursive:true,force:true});
    await cp(staging,root,{recursive:true,force:true});
    if(wasRunning&&container)await container.start().catch(()=>undefined);
    reply(res,200,{backup_id:backupId,restored:true,files,size_bytes:totalBytes});return;
   }finally{await rm(staging,{recursive:true,force:true}).catch(()=>undefined);}
  }
  if(["logs","file_list","file_read","file_write","file_delete","file_mkdir"].includes(action)){
   const input=raw?JSON.parse(raw):{};const root=await projectDirectory(id);const relative=String(input.path||"");
   if(relative.length>512||relative.startsWith("/")||relative.split("/").some((part:string)=>part===".."||part==="."))throw new Error("INVALID_FILE_PATH");
   const target=resolve(root,relative||".");if(target!==root&&!target.startsWith(root+sep))throw new Error("INVALID_FILE_PATH");
   if(target!==root){const parent=resolve(target,"..");const realParent=await realpath(parent);if(realParent!==root&&!realParent.startsWith(root+sep))throw new Error("INVALID_FILE_PATH");}
   if(action==="logs"){
    const container=await getContainer(id);const info=await container.inspect();const logs=await container.logs({stdout:true,stderr:true,tail:250,timestamps:true});
    reply(res,200,{id,status:info.State.Status,logs:Buffer.from(logs).toString("utf8").slice(-80000)});return;
   }
   if(action==="file_list"){
    const dir=await realpath(target);if(dir!==root&&!dir.startsWith(root+sep))throw new Error("INVALID_FILE_PATH");
    const entries=await readdir(dir,{withFileTypes:true});const output=[];
    for(const entry of entries.slice(0,300)){if(entry.isSymbolicLink())continue;const full=resolve(dir,entry.name);const st=await lstat(full);output.push({name:entry.name,type:entry.isDirectory()?"directory":"file",size:st.isFile()?st.size:0});}
    reply(res,200,{path:relative,entries:output});return;
   }
   if(action==="file_read"){
    const st=await lstat(target);if(!st.isFile()||st.isSymbolicLink())throw new Error("FILE_NOT_READABLE");
    const offset=Math.max(0,Math.floor(Number(input.offset||0))),length=Math.max(1,Math.min(48*1024,Math.floor(Number(input.length||65536))));
    if(!Number.isSafeInteger(offset)||offset>st.size)throw new Error("INVALID_FILE_OFFSET");
    if(st.size>65536&&input.offset===undefined)throw new Error("FILE_REQUIRES_CHUNKED_DOWNLOAD");
    const data=await open(target,"r").then(async handle=>{try{const buffer=Buffer.alloc(Math.min(length,Math.max(0,st.size-offset)));if(buffer.length)await handle.read(buffer,0,buffer.length,offset);return buffer;}finally{await handle.close();}});
    reply(res,200,{path:relative,content_base64:data.toString("base64"),size:st.size,offset,next_offset:offset+data.length,eof:offset+data.length>=st.size});return;
   }
   if(action==="file_write"){
    if(!relative||typeof input.content_base64!=="string"||input.content_base64.length>90000)throw new Error("INVALID_FILE_WRITE");
    const data=Buffer.from(input.content_base64,"base64");if(data.length>65536)throw new Error("FILE_TOO_LARGE");
    let existingFiles=0,existingBytes=0;const scan=async(dir:string):Promise<void>=>{for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const full=resolve(dir,entry.name);if(entry.isDirectory())await scan(full);else if(entry.isFile()){const st=await lstat(full);existingFiles++;existingBytes+=st.size;}}};await scan(root);
    let replacing=false;try{const st=await lstat(target);if(st.isSymbolicLink()||!st.isFile())throw new Error("UNSAFE_FILE_TARGET");replacing=true;existingBytes-=st.size;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    const maxFiles=Math.max(1,Math.min(10000,Number(input.max_files||100)));const maxBytes=Math.max(1,Math.min(1024*1024*1024,Number(input.storage_mb||512)*1024*1024));
    if(!replacing&&existingFiles>=maxFiles)throw new Error("PLAN_FILE_LIMIT_REACHED");if(existingBytes+data.length>maxBytes)throw new Error("PLAN_STORAGE_LIMIT_REACHED");
    await writeFile(target,data,{mode:0o660});reply(res,200,{path:relative,saved:true,size:data.length});return;
   }
   if(action==="file_mkdir"){await mkdir(target,{mode:0o770});reply(res,200,{path:relative,created:true});return;}
   if(action==="file_delete"){
    const st=await lstat(target);if(st.isSymbolicLink()||(!st.isFile()&&!st.isDirectory()))throw new Error("UNSAFE_FILE_TARGET");
    await rm(target,{recursive:false,force:false});reply(res,200,{path:relative,deleted:true});return;
   }
  }
  if(action==="status"){
   try{const info=await (await getContainer(id)).inspect();reply(res,200,{id,status:info.State.Status,running:info.State.Running,exitCode:info.State.ExitCode});}
   catch{reply(res,200,{id,status:"not_created",running:false});}return;
  }
  if(action==="delete"){try{const container=await getContainer(id);await container.stop({t:10}).catch(()=>undefined);await container.remove({force:true});}catch{}reply(res,200,{id,status:"deleted"});return;}
  if(action==="stop"){try{await (await getContainer(id)).stop({t:10});}catch{}reply(res,200,{id,status:"stopped"});return;}
  const input=raw?JSON.parse(raw):{};
  const runtime=String(input.runtime||"");const version=String(input.version||"");const image=versions[runtime+":"+version];
  if(!image){reply(res,400,{error:"UNSUPPORTED_RUNTIME_VERSION"});return;}
  const startup=String(input.startup_command||"").trim();
  const cpuMillicores=Number(input.cpu_millicores||500);const ramMb=Number(input.ram_mb||512);const pidsLimit=Number(input.pids_limit||128);
  if(!Number.isInteger(cpuMillicores)||cpuMillicores<100||cpuMillicores>4000||!Number.isInteger(ramMb)||ramMb<128||ramMb>8192||!Number.isInteger(pidsLimit)||pidsLimit<32||pidsLimit>512){reply(res,400,{error:"INVALID_RESOURCE_LIMITS"});return;}
  if(!startup||startup.length>500){reply(res,400,{error:"INVALID_STARTUP_COMMAND"});return;}
  const envInput=input.env&&typeof input.env==="object"?input.env:{};
  const env=Object.entries(envInput).slice(0,100).map(([key,value])=>{if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)||typeof value!=="string"||value.length>8192)throw new Error("INVALID_ENVIRONMENT");return key+"="+value;});
  const dir=await projectDirectory(id);
  let container;
  try{container=await getContainer(id);const info=await container.inspect();if(info.State.Running){await container.stop({t:10});}await container.remove({force:true});}catch{}
  container=await docker.createContainer({
   name,Image:image,Cmd:["/bin/sh","-lc",startup],WorkingDir:"/workspace",User:"0:0",Env:["HOME=/workspace","PIP_NO_CACHE_DIR=1","PYTHONDONTWRITEBYTECODE=1","PYTHONUNBUFFERED=1","npm_config_cache=/workspace/.hostpilot/npm-cache",...env.filter(item=>!["HOME","PIP_NO_CACHE_DIR","PYTHONDONTWRITEBYTECODE","PYTHONUNBUFFERED","npm_config_cache"].includes(item.split("=")[0]))],
   Labels:{"com.hostpilot.managed":"true","com.hostpilot.project":id},
   HostConfig:{
    Binds:[dir+":/workspace:rw"],NetworkMode:"bridge",Memory:ramMb*1024*1024,MemorySwap:ramMb*1024*1024,
    NanoCpus:cpuMillicores*1000000,PidsLimit:pidsLimit,ReadonlyRootfs:true,CapDrop:["ALL"],
    SecurityOpt:["no-new-privileges:true"],Tmpfs:{"/tmp":"rw,noexec,nosuid,size=64m"},
    RestartPolicy:{Name:"on-failure",MaximumRetryCount:3},
    LogConfig:{Type:"json-file",Config:{"max-size":"10m","max-file":"3"}}
   }
  });
  await container.start();reply(res,200,{id,status:"running",container:name,image});
 }catch(error){reply(res,400,{error:error instanceof Error?error.message:"AGENT_ERROR"});}
});
const SSH_BIND=process.env.TERMINAL_SSH_BIND||"0.0.0.0";
const SSH_PORT=Number(process.env.TERMINAL_SSH_PORT||2222);
const SSH_HOST_KEY=resolve(process.env.TERMINAL_SSH_HOST_KEY||"/srv/hostpilot/ssh/host_ed25519");
const terminalKeys=new Map<string,Set<string>>();
const terminalProjects=new Map<string,string>();
const activeSessions=new Map<string,Set<any>>();
let terminalKeysLastSync=0;
function closeStaleTerminalSessions(){if(Date.now()-terminalKeysLastSync>45000){for(const sessions of activeSessions.values())for(const session of sessions)session.end("HostPilot terminal authorization sync is unavailable.");}}
async function loadSshHostKey(){
 await mkdir(resolve(SSH_HOST_KEY,".."),{recursive:true,mode:0o700});
 try{return await readFile(SSH_HOST_KEY,"utf8");}catch{}
 const pair=generateKeyPairSync("ed25519",{privateKeyEncoding:{type:"pkcs8",format:"pem"},publicKeyEncoding:{type:"spki",format:"pem"}});
 try{await writeFile(SSH_HOST_KEY,pair.privateKey,{mode:0o600,flag:"wx"});return pair.privateKey;}catch{return await readFile(SSH_HOST_KEY,"utf8");}
}
async function refreshTerminalKeys(){
 if(!CONTROL_PLANE_URL||!NODE_TOKEN)return;
 const response=await fetch(CONTROL_PLANE_URL+"/api/agent/terminal/keys",{headers:{authorization:"Bearer "+NODE_TOKEN},signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw new Error("TERMINAL_KEY_SYNC_"+response.status);
 const payload=await response.json() as {keys?:Array<{username:string;project_id:string;key_blob:string}>};
 const next=new Map<string,Set<string>>();const nextProjects=new Map<string,string>();
 for(const item of payload.keys||[]){if(!/^hp_[a-f0-9]{32}$/i.test(item.username)||!/^[A-Za-z0-9+/]+={0,2}$/.test(item.key_blob))continue;const set=next.get(item.username)||new Set<string>();set.add(item.key_blob);next.set(item.username,set);nextProjects.set(item.username,item.project_id);}
 for(const [username,oldKeys] of terminalKeys){const newKeys=next.get(username)||new Set<string>();if([...oldKeys].some(key=>!newKeys.has(key))){for(const session of activeSessions.get(username)||[])session.end("HostPilot SSH key revoked or rotated.");}}
 terminalKeys.clear();for(const [username,keys] of next)terminalKeys.set(username,keys);terminalProjects.clear();for(const [username,id] of nextProjects)terminalProjects.set(username,id);terminalKeysLastSync=Date.now();
}
async function startTerminalGateway(){
 if(!CONTROL_PLANE_URL||!NODE_TOKEN){process.stderr.write("Terminal SSH gateway disabled: configure CONTROL_PLANE_URL and NODE_TOKEN.\\n");return;}
 if(!Number.isInteger(SSH_PORT)||SSH_PORT<1||SSH_PORT>65535)throw new Error("INVALID_TERMINAL_SSH_PORT");
 const hostKey=await loadSshHostKey();
 const ssh:any=new SSHServer({hostKeys:[hostKey]},(client:any)=>{
  let authenticatedUser="";
  client.on("authentication",(ctx:any)=>{
   const keys=terminalKeys.get(ctx.username);const presented=ctx.key?.data?.toString("base64");
   if(ctx.method==="publickey"&&keys&&presented&&keys.has(presented)&&Date.now()-terminalKeysLastSync<45000){authenticatedUser=ctx.username;ctx.accept();}else ctx.reject();
  });
  client.on("ready",()=>{
   client.on("session",(acceptSession:any,rejectSession:any)=>{
    if(!authenticatedUser){rejectSession();return;}
    const session=acceptSession();let hasPty=false;
    session.on("pty",(accept:any,reject:any)=>{hasPty=true;accept();});
    session.on("shell",(accept:any,reject:any)=>{
     if(!hasPty){reject();return;}
     const sessions=activeSessions.get(authenticatedUser)||new Set<any>();if(sessions.size>=3){reject();return;}
     const channel=accept();let terminalStream:any,idle:any,maxLife:any;channel.on("close",()=>{clearTimeout(idle);clearTimeout(maxLife);if(terminalStream)terminalStream.destroy();sessions.delete(channel);if(!sessions.size)activeSessions.delete(authenticatedUser);});sessions.add(channel);activeSessions.set(authenticatedUser,sessions);
     const projectId=terminalProjects.get(authenticatedUser)||"";
     void (async()=>{
      try{const container=await getContainer(projectId);const info=await container.inspect();if(!info.State.Running){channel.stderr.write("HostPilot: project is stopped. Start it from the Mini App first.\\r\\n");channel.end();return;}
       const exec=await container.exec({Cmd:["/bin/sh"],User:"0:0",WorkingDir:"/workspace",Env:["HOME=/workspace","TERM=xterm-256color"],AttachStdin:true,AttachStdout:true,AttachStderr:true,Tty:true});
       terminalStream=await exec.start({hijack:true,stdin:true});channel.pipe(terminalStream);terminalStream.pipe(channel);
       session.on("window-change",(size:any)=>{void exec.resize({h:size.rows,w:size.cols}).catch(()=>undefined);});
       idle=setTimeout(()=>channel.end("HostPilot terminal idle timeout."),30*60*1000);idle.unref?.();maxLife=setTimeout(()=>channel.end("HostPilot terminal maximum session duration reached."),4*60*60*1000);maxLife.unref?.();
       const resetIdle=()=>{clearTimeout(idle);idle=setTimeout(()=>channel.end("HostPilot terminal idle timeout."),30*60*1000);idle.unref?.();};
       channel.on("data",resetIdle);terminalStream.on("data",resetIdle);
       
      }catch{channel.stderr.write("HostPilot: unable to open this project container.\\r\\n");channel.end();sessions.delete(channel);if(!sessions.size)activeSessions.delete(authenticatedUser);}
     })();
    });
    session.on("exec",(_accept:any,reject:any)=>reject());
    session.on("subsystem",(_accept:any,reject:any)=>reject());
   });
  });
 });
 await refreshTerminalKeys().catch(error=>process.stderr.write("Terminal key sync failed: "+String(error)+"\\n"));
 ssh.listen(SSH_PORT,SSH_BIND,()=>process.stdout.write("HostPilot project SSH gateway listening on "+SSH_BIND+":"+SSH_PORT+"\\n"));
 setInterval(()=>void refreshTerminalKeys().catch(error=>{closeStaleTerminalSessions();process.stderr.write("Terminal key sync failed: "+String(error)+"\\n");}),15000).unref();
}
const CONTROL_PLANE_URL=(process.env.CONTROL_PLANE_URL||"").replace(/\/$/,"");
const NODE_TOKEN=process.env.NODE_TOKEN||"";


function zipCrc32(data:Buffer){let crc=0xffffffff;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function shellQuote(value:string){return "'"+value.replace(/'/g,"'\\''")+"'";}
async function extractProjectZip(archive:Buffer,id:string,runtime:string,maxFiles=500,storageMb=100){
 if(archive.length<22||archive.length>20*1024*1024)throw new Error("ZIP_SIZE_INVALID");
 let eocd=-1;for(let i=archive.length-22;i>=Math.max(0,archive.length-65557);i--){if(archive.readUInt32LE(i)===0x06054b50){eocd=i;break;}}
 if(eocd<0)throw new Error("ZIP_DIRECTORY_MISSING");
 const entries=archive.readUInt16LE(eocd+10),centralSize=archive.readUInt32LE(eocd+12),centralOffset=archive.readUInt32LE(eocd+16);
 if(entries<1||entries>500||entries>maxFiles||centralOffset+centralSize>eocd)throw new Error("ZIP_ENTRY_LIMIT_OR_DIRECTORY_INVALID");
 const rawEntries:Array<{name:string;method:number;compressed:number;size:number;crc:number;offset:number;mode:number}>=[];
 let pos=centralOffset,total=0;
 for(let i=0;i<entries;i++){
  if(pos+46>archive.length||archive.readUInt32LE(pos)!==0x02014b50)throw new Error("ZIP_DIRECTORY_CORRUPT");
  const flags=archive.readUInt16LE(pos+8),method=archive.readUInt16LE(pos+10),crc=archive.readUInt32LE(pos+16),compressed=archive.readUInt32LE(pos+20),size=archive.readUInt32LE(pos+24);
  const nameLen=archive.readUInt16LE(pos+28),extraLen=archive.readUInt16LE(pos+30),commentLen=archive.readUInt16LE(pos+32),mode=archive.readUInt32LE(pos+38)>>>16,offset=archive.readUInt32LE(pos+42);
  if(flags&1||![0,8].includes(method))throw new Error("ZIP_ENCRYPTION_OR_COMPRESSION_UNSUPPORTED");
  const name=archive.subarray(pos+46,pos+46+nameLen).toString("utf8");
  if(!name||name.includes("\\")||name.startsWith("/")||/^[A-Za-z]:/.test(name)||name.split("/").some(part=>part===".."||part==="."))throw new Error("ZIP_UNSAFE_PATH");
  if((mode&0xf000)===0xa000)throw new Error("ZIP_SYMLINK_NOT_ALLOWED");
  if(size>20*1024*1024)throw new Error("ZIP_FILE_TOO_LARGE");
  total+=size;if(total>100*1024*1024||total>Math.max(1,storageMb)*1024*1024)throw new Error("ZIP_EXPANDED_SIZE_LIMIT");
  if(compressed===0?size>0:size/compressed>100)throw new Error("ZIP_COMPRESSION_RATIO_LIMIT");
  rawEntries.push({name,method,compressed,size,crc,offset,mode});pos+=46+nameLen+extraLen+commentLen;
 }
 const files=rawEntries.filter(x=>!x.name.endsWith("/"));const first=files.map(x=>x.name.split("/")[0]);
 const stripRoot=files.length>0&&first.every(x=>x===first[0])&&rawEntries.some(x=>x.name===first[0]+"/");
 const root=await projectDirectory(id);await rm(root,{recursive:true,force:true});await mkdir(root,{recursive:true,mode:0o770});
 const extracted:string[]=[];
 for(const item of files){
  const relative=stripRoot?item.name.slice(first[0].length+1):item.name;if(!relative)continue;
  const parts=relative.split("/");if(parts.some(p=>!p||p==="."||p===".."))throw new Error("ZIP_UNSAFE_PATH");
  const target=resolve(root,relative);if(!target.startsWith(root+sep))throw new Error("ZIP_PATH_TRAVERSAL");
  const local=item.offset;if(local+30>archive.length||archive.readUInt32LE(local)!==0x04034b50)throw new Error("ZIP_LOCAL_HEADER_INVALID");
  const start=local+30+archive.readUInt16LE(local+26)+archive.readUInt16LE(local+28),end=start+item.compressed;if(end>archive.length)throw new Error("ZIP_DATA_TRUNCATED");
  const packed=archive.subarray(start,end);const content=item.method===0?Buffer.from(packed):inflateRawSync(packed,{maxOutputLength:20*1024*1024});
  if(content.length!==item.size||zipCrc32(content)!==item.crc)throw new Error("ZIP_INTEGRITY_CHECK_FAILED");
  await mkdir(resolve(target,".."),{recursive:true,mode:0o770});const parent=await realpath(resolve(target,".."));if(!parent.startsWith(root+sep))throw new Error("ZIP_PATH_ESCAPE");
  await writeFile(target,content,{flag:"wx",mode:0o660});extracted.push(relative);
 }
 const filesFound=extracted.sort();const manifests=filesFound.filter(x=>["requirements.txt","pyproject.toml","Pipfile","package.json","package-lock.json","pnpm-lock.yaml","yarn.lock"].includes(x.split("/").pop()||""));
 let entry="",startup="";
 const packagePath=runtime==="nodejs"?(filesFound.includes("package.json")?"package.json":filesFound.find(x=>x.endsWith("/package.json"))):undefined;
 if(runtime==="nodejs"){
  const packageData=packagePath?JSON.parse(await readFile(resolve(root,packagePath),"utf8")):{};const base=packagePath&&packagePath.includes("/")?packagePath.slice(0,packagePath.lastIndexOf("/"))+"/":"";
  const hasStart=typeof packageData.scripts?.start==="string";const declared=typeof packageData.main==="string"?base+packageData.main:"";
  entry=declared&&filesFound.includes(declared)?declared:(["index.js","main.js","app.js","server.js","src/index.js"].map(x=>base+x).find(x=>filesFound.includes(x))||"");
  if(!entry&&!hasStart)throw new Error("NODE_ENTRY_FILE_NOT_FOUND");if(!entry)entry="package.json (scripts.start)";
  startup=(packagePath?"cd "+shellQuote("/workspace/"+base)+" && npm install --no-audit --no-fund && ":"")+(hasStart?"npm start":"node "+shellQuote("/workspace/"+entry));
 }else{
  entry=filesFound.find(x=>["main.py","bot.py","app.py","run.py","index.py"].includes(x.split("/").pop()||""))||"";
  if(!entry)throw new Error("PYTHON_ENTRY_FILE_NOT_FOUND");
  const req=filesFound.includes("requirements.txt")?"python -m pip install --disable-pip-version-check --target=/workspace/.hostpilot/python-deps -r /workspace/requirements.txt && PYTHONPATH=/workspace/.hostpilot/python-deps ":filesFound.includes("pyproject.toml")?"python -m pip install --disable-pip-version-check --target=/workspace/.hostpilot/python-deps . && PYTHONPATH=/workspace/.hostpilot/python-deps ":"";
  startup=req+"python "+shellQuote("/workspace/"+entry);
 }
 return {entry_file:entry,startup_command:startup,files:filesFound.slice(0,200),manifests,runtime};
}

let taskPollBusy=false;
async function signedLocalAgentAction(path:string,body:unknown){
 const raw=JSON.stringify(body||{});const ts=String(Math.floor(Date.now()/1000));const nonce=randomUUID();
 const bodyHash=createHash("sha256").update(raw).digest("hex");
 const signature=createHmac("sha256",SECRET).update([ts,nonce,"POST",path,bodyHash].join("\n")).digest("hex");
 const response=await fetch("http://127.0.0.1:"+PORT+path,{method:"POST",headers:{"content-type":"application/json","x-hostpilot-timestamp":ts,"x-hostpilot-nonce":nonce,"x-hostpilot-signature":signature},body:raw,signal:AbortSignal.timeout(120000)});
 const data=await response.json().catch(()=>({error:"INVALID_AGENT_RESPONSE"})) as any;
 if(!response.ok)throw new Error(String(data.error||"AGENT_ACTION_FAILED"));
 return data;
}
async function pollAgentTasks(){
 if(taskPollBusy||!CONTROL_PLANE_URL||!NODE_TOKEN)return;
 taskPollBusy=true;
 try{
  const response=await fetch(CONTROL_PLANE_URL+"/api/agent/tasks",{headers:{authorization:"Bearer "+NODE_TOKEN},signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error("TASK_POLL_"+response.status);
  const data=await response.json() as {task?:{id:string;project_id:string;action:string;payload_json:string;lease_token:string}|null};
  const task=data.task;if(!task)return;
  let result:unknown=null;let error="";
  try{
   if(!/^[a-f0-9-]{36}$/i.test(task.project_id))throw new Error("INVALID_TASK_PROJECT");
   const payload=JSON.parse(task.payload_json||"{}");
   let uploadResult:any=null;
   if(payload.upload_id){
    const metaResponse=await fetch(CONTROL_PLANE_URL+"/api/agent/uploads/"+encodeURIComponent(String(payload.upload_id)),{headers:{authorization:"Bearer "+NODE_TOKEN},signal:AbortSignal.timeout(15000)});
    if(!metaResponse.ok)throw new Error("UPLOAD_METADATA_UNAVAILABLE");
    const meta=(await metaResponse.json() as any).upload;
    if(!meta||!Number.isInteger(meta.chunk_count)||meta.chunk_count<1)throw new Error("UPLOAD_METADATA_INVALID");
    if(payload.file_upload){
     if(meta.chunk_count>2048||Number(meta.size_bytes)<1||Number(meta.size_bytes)>Math.min(500*1024*1024,Number(payload.max_file_bytes||0)))throw new Error("PLAN_FILE_SIZE_LIMIT");
     let metadata:any={};try{metadata=JSON.parse(meta.detected_json||"{}");}catch{}
     const relative=String(metadata.path||payload.path||"");
     if(metadata.kind!=="file"||!relative||relative.length>512||relative.startsWith("/")||relative.split("/").some((part:string)=>!part||part==="."||part===".."))throw new Error("INVALID_FILE_PATH");
     const root=await projectDirectory(task.project_id),target=resolve(root,relative);
     if(target!==root&&!target.startsWith(root+sep))throw new Error("INVALID_FILE_PATH");
     await mkdir(dirname(target),{recursive:true,mode:0o770});
     const parent=await realpath(dirname(target));if(parent!==root&&!parent.startsWith(root+sep))throw new Error("INVALID_FILE_PATH");
     let replacing=false,oldSize=0;
     try{const st=await lstat(target);if(st.isSymbolicLink()||!st.isFile())throw new Error("UNSAFE_FILE_TARGET");replacing=true;oldSize=st.size;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
     let existingFiles=0,existingBytes=0;
     const scan=async(dir:string):Promise<void>=>{for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const full=resolve(dir,entry.name);if(entry.isDirectory())await scan(full);else if(entry.isFile()){const st=await lstat(full);existingFiles++;existingBytes+=st.size;}}};
     await scan(root);
     const maxFiles=Math.max(1,Math.min(10000,Number(payload.max_files||100)));
     const maxBytes=Math.max(1,Math.min(1024*1024*1024,Number(payload.storage_mb||512)*1024*1024));
     if(!replacing&&existingFiles>=maxFiles)throw new Error("PLAN_FILE_LIMIT_REACHED");
     if(existingBytes-oldSize+Number(meta.size_bytes)>maxBytes)throw new Error("PLAN_STORAGE_LIMIT_REACHED");
     const temp=target+".hostpilot-"+randomUUID()+".tmp";let handle:Awaited<ReturnType<typeof open>>|undefined;let written=0;
     try{
      handle=await open(temp,"wx",0o660);
      for(let i=0;i<meta.chunk_count;i++){
       const response=await fetch(CONTROL_PLANE_URL+"/api/agent/uploads/"+encodeURIComponent(String(payload.upload_id))+"/chunks/"+i,{headers:{authorization:"Bearer "+NODE_TOKEN},signal:AbortSignal.timeout(60000)});
       if(!response.ok)throw new Error("UPLOAD_CHUNK_DOWNLOAD_FAILED");
       const chunk=Buffer.from(await response.arrayBuffer());if(chunk.length>256*1024||written+chunk.length>Number(meta.size_bytes))throw new Error("UPLOAD_CHUNK_INVALID");
       await handle.write(chunk);written+=chunk.length;
      }
      await handle.sync();await handle.close();handle=undefined;
      if(written!==Number(meta.size_bytes))throw new Error("UPLOAD_SIZE_MISMATCH");
      await rename(temp,target);
     }catch(error){if(handle)await handle.close().catch(()=>undefined);await rm(temp,{force:true}).catch(()=>undefined);throw error;}
     result={path:relative,size:written,uploaded:true};
    }else{
     if(meta.chunk_count>80)throw new Error("UPLOAD_METADATA_INVALID");
     const chunks:Buffer[]=[];
     for(let i=0;i<meta.chunk_count;i++){const response=await fetch(CONTROL_PLANE_URL+"/api/agent/uploads/"+encodeURIComponent(String(payload.upload_id))+"/chunks/"+i,{headers:{authorization:"Bearer "+NODE_TOKEN},signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error("UPLOAD_CHUNK_DOWNLOAD_FAILED");chunks.push(Buffer.from(await response.arrayBuffer()));}
     await signedLocalAgentAction("/v1/projects/"+task.project_id+"/stop",{}).catch(()=>undefined);uploadResult=await extractProjectZip(Buffer.concat(chunks),task.project_id,String(payload.runtime||"python"),Number(payload.max_files||500),Number(payload.storage_mb||100));payload.startup_command=uploadResult.startup_command;
     result=await signedLocalAgentAction("/v1/projects/"+task.project_id+"/start",payload);
     result={...(result as any),...uploadResult};
    }
   }
   const controlAction=String(payload.control_action||"");
   if(["logs","file_list","file_read","file_write","file_delete","file_mkdir"].includes(controlAction)){
    result=await signedLocalAgentAction("/v1/projects/"+task.project_id+"/"+controlAction,payload);
   }else if(controlAction==="backup"&&["create","restore","delete"].includes(payload.backup_action)){
    result=await signedLocalAgentAction("/v1/projects/"+task.project_id+"/"+(payload.backup_action==="create"?"backup":payload.backup_action==="delete"?"backup_delete":"restore"),payload);
   }else if(!payload.upload_id&&["start","stop","restart"].includes(controlAction)){
    result=await signedLocalAgentAction("/v1/projects/"+task.project_id+"/"+controlAction,payload);
   }
   const action=payload.upload_id?"upload_done":(controlAction?"control_done":(task.action==="create"?"start":task.action));
   if(action!=="upload_done"&&action!=="control_done"&&!["start","stop","restart","delete"].includes(action))throw new Error("UNSUPPORTED_TASK_ACTION");
   if(action!=="upload_done"&&action!=="control_done")result=await signedLocalAgentAction("/v1/projects/"+task.project_id+"/"+action,payload);
  }catch(e){error=e instanceof Error?e.message:"AGENT_TASK_FAILED";}
  const ack=await fetch(CONTROL_PLANE_URL+"/api/agent/tasks/"+task.id+"/result",{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+NODE_TOKEN},body:JSON.stringify({lease_token:task.lease_token,ok:!error,result,error}),signal:AbortSignal.timeout(10000)});
  if(!ack.ok)process.stderr.write("HostPilot task acknowledgement failed: "+ack.status+"\n");
 }catch(error){process.stderr.write("HostPilot task polling failed: "+(error instanceof Error?error.message:"unknown error")+"\n");}
 finally{taskPollBusy=false;}
}

async function sendHeartbeat(){
 if(!CONTROL_PLANE_URL||!NODE_TOKEN)return;
 try{
  await mkdir(PROJECT_ROOT,{recursive:true,mode:0o770});
  let dockerReady=false;
  let dockerVersion="unavailable";
  try{await docker.ping();dockerReady=true;const info=await docker.version();dockerVersion=String(info.Version||"unknown");}catch{}
  let diskTotalMb=0,diskFreeMb=0;
  try{const disk=await statfs(PROJECT_ROOT);diskTotalMb=Math.floor(disk.blocks*disk.bsize/1048576);diskFreeMb=Math.floor(disk.bavail*disk.bsize/1048576);}catch{}
  const linux=os.platform()==="linux";
  const response=await fetch(CONTROL_PLANE_URL+"/api/agent/heartbeat",{
   method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+NODE_TOKEN},
   signal:AbortSignal.timeout(8000),
   body:JSON.stringify({agent_version:"0.3.0",status:linux&&dockerReady?"healthy":"unhealthy",capacity:{
    platform:os.platform(),os_release:os.release(),architecture:os.arch(),
    cpu_cores:os.cpus().length,memory_total_mb:Math.floor(os.totalmem()/1048576),
    memory_free_mb:Math.floor(os.freemem()/1048576),disk_total_mb:diskTotalMb,disk_free_mb:diskFreeMb,
    node_version:process.version,docker_available:dockerReady,docker_version:dockerVersion,
    supported_runtimes:Object.keys(versions)
   }})
  });
  if(!response.ok)process.stderr.write("HostPilot heartbeat rejected: "+response.status+"\\n");
 }catch(error){process.stderr.write("HostPilot heartbeat failed: "+(error instanceof Error?error.message:"network error")+"\\n");}
}
void startTerminalGateway().catch(error=>process.stderr.write("Terminal gateway failed to start: "+String(error)+"\\n"));
server.listen(PORT,"127.0.0.1",()=>{
 if(!SECRET)process.stderr.write("HOSTPILOT_AGENT_SECRET is required; signed actions will be rejected.\\n");
 process.stdout.write("HostPilot agent listening on 127.0.0.1:"+PORT+"\\n");
 if(!CONTROL_PLANE_URL||!NODE_TOKEN)process.stderr.write("Set CONTROL_PLANE_URL and NODE_TOKEN to connect this VPS to HostPilot.\\n");
 else {void sendHeartbeat();setInterval(()=>void sendHeartbeat(),30000);void pollAgentTasks();setInterval(()=>void pollAgentTasks(),5000).unref();}
});
