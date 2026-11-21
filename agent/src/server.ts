import http from "node:http";
import { createHash, createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import Docker from "dockerode";

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
  if(!startup||startup.length>500){reply(res,400,{error:"INVALID_STARTUP_COMMAND"});return;}
  const envInput=input.env&&typeof input.env==="object"?input.env:{};
  const env=Object.entries(envInput).slice(0,100).map(([key,value])=>{if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)||typeof value!=="string"||value.length>8192)throw new Error("INVALID_ENVIRONMENT");return key+"="+value;});
  const dir=await projectDirectory(id);
  let container;
  try{container=await getContainer(id);const info=await container.inspect();if(info.State.Running){await container.stop({t:10});}await container.remove({force:true});}catch{}
  container=await docker.createContainer({
   name,Image:image,Cmd:["/bin/sh","-lc",startup],WorkingDir:"/workspace",User:"10001:10001",Env:env,
   Labels:{"com.hostpilot.managed":"true","com.hostpilot.project":id},
   HostConfig:{
    Binds:[dir+":/workspace:rw"],NetworkMode:"bridge",Memory:536870912,MemorySwap:536870912,
    NanoCpus:500000000,PidsLimit:128,ReadonlyRootfs:true,CapDrop:["ALL"],
    SecurityOpt:["no-new-privileges:true"],Tmpfs:{"/tmp":"rw,noexec,nosuid,size=64m"},
    RestartPolicy:{Name:"on-failure",MaximumRetryCount:3},
    LogConfig:{Type:"json-file",Config:{"max-size":"10m","max-file":"3"}}
   }
  });
  await container.start();reply(res,200,{id,status:"running",container:name,image});
 }catch(error){reply(res,400,{error:error instanceof Error?error.message:"AGENT_ERROR"});}
});
server.listen(PORT,"127.0.0.1",()=>{if(!SECRET)process.stderr.write("HOSTPILOT_AGENT_SECRET is required; signed actions will be rejected.\n");process.stdout.write("HostPilot agent listening on 127.0.0.1:"+PORT+"\n");});
