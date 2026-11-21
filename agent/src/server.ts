import http from "node:http";
import { createHash, createHmac, timingSafeEqual, randomUUID, generateKeyPairSync } from "node:crypto";
import { mkdir, realpath, statfs, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import os from "node:os";
import Docker from "dockerode";
import { Server as SSHServer } from "ssh2";

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
async function readBody(req:http.IncomingMessage):Promise<string>{let raw="";for await(const chunk of req) {raw+=chunk.toString();if(raw.length>65536)throw new Error("BODY_TOO_LARGE");}return raw;}
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
  const match=(req.url||"").match(/^\/v1\/projects\/([a-f0-9-]{36})\/(start|stop|restart|delete|status)$/i);
  if(req.method!=="POST"||!match){reply(res,404,{error:"NOT_FOUND"});return;}
  const id=safeId(match[1]);const action=match[2];const name="hp-"+id;
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
   name,Image:image,Cmd:["/bin/sh","-lc",startup],WorkingDir:"/workspace",User:"0:0",Env:env,
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
 else {void sendHeartbeat();setInterval(()=>void sendHeartbeat(),30000);}
});
