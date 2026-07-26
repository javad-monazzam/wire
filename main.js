const http = require('http');
const shell = require('shelljs');
const eURL = require('url');
const site_server = http.createServer();
const { networkInterfaces } = require('os');
const logger = require('logger').createLogger("vpn.log");
const TronWeb = require('tronweb')
const bcrypt = require('bcrypt');
const fs = require('fs');
const peers = require('./peers');
const httpPort = 5500;
const version = 2.2;
const resolveConfFile = "/etc/resolv.conf"
const serverConfFile = "/etc/openvpn/server/server.conf"
let Contract = null;
let tronWeb = null;
let smartAddress = "";
const sleep = require('sleep-promise');


startHttpServer();
async function startHttpServer() {

  
    logger.info("http server start ...");

    site_server.on('error', (err)=>{
        logger.error("http server error ", err.stack);
    });

    site_server.on('request', async function (req, res) {

        logger.info("*** start request", req.method);

        try {

            let U = eURL.parse(req.url, true);
            logger.info("request info", req.method, JSON.stringify(U));

            if (req.method === "GET") {
                switch (U.pathname.replace(/^\/|\/$/g, '')) {
                    case "vpn/create" :
                        await addVpn(req, res, U.query);
                        break;
                    case "vpn/remove" :
                        await removeVpn(req, res, U.query);
                        break;
                     case "list" :
                        await listUser(req, res, U.query);
                        break;
                    case "check" :
                        await checkToken(req,res,U.query);
                        break; 
                    case "enable" :
                        await setPeerState(res, U.query, true);
                        break;
                    case "disable" :
                        await setPeerState(res, U.query, false);
                        break;
                    case "status" :
                        await peerStatus(res, U.query);
                        break;
                    case "peers" :
                        await peerList(res);
                        break;

                    default :
                        logger.info("pathname not found !", U.pathname);
                }
            }

            logger.info("*** end request");

        }catch (e) {
            logger.error("DANGER !!!! >>> in request ", e.message);
        }

        res.end();
    });

    site_server.listen(httpPort);
    logger.info("http server listen on " + httpPort);
}

    let privateIP ;
    async function findIp(){

      // خواندن ساب‌نت و نام اینترفیس از /etc/wireguard/params به جای هارد کد
      const params = fs.readFileSync('/etc/wireguard/params', 'utf8');
      const nic  = (params.match(/^SERVER_WG_NIC=(.+)$/m)  || [])[1];
      const wgip = (params.match(/^SERVER_WG_IPV4=(.+)$/m) || [])[1];

      if (!nic || !wgip) throw new Error('SERVER_WG_NIC / SERVER_WG_IPV4 not found in params');

      // 156.6.86.1  ->  156.6.86
      const baseIP = wgip.trim().split('.').slice(0, 3).join('.');
      logger.info('subnet from params', baseIP + '.0/24', 'nic', nic.trim());

      await fs.readFile(`/etc/wireguard/${nic.trim()}.conf`, 'utf8', (err, data) => {
      if (err) throw err;
    
      const allowedIPs = [];
    
      const lines = data.split('\n');
    
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
    
        if (line.startsWith('AllowedIPs')) {
          const ips = line.substring(line.indexOf('=') + 1).trim().split(',');
    
          for (let j = 0; j < ips.length; j++) {
            const ip = ips[j].trim();
    
            if (!allowedIPs.includes(ip)) {
              allowedIPs.push(ip);
            }
          }
        }
      }
        const ipv4 = allowedIPs.filter(ip => ip.includes('.'));
        
        for(i = 3 ; i<250;i++){
             const ipToCheck = `${baseIP}.${i}/32`;

        if (allowedIPs.includes(ipToCheck)) {
          logger.info(`${ipToCheck} exists in the array.`);
        } else {
          logger.info(`${ipToCheck} does not exist in the array.`);
          privateIP = i;
          return
        }
        
        
        }
        
       
                
        
      logger.info('here is allowip ' ,ipv4);
    });
    }


// ---------------------------------------------------------------------------
// Enable / disable peers
// ---------------------------------------------------------------------------

function sendJson(res, code, body) {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.write(JSON.stringify(body));
}

// The rest of this file uses `publicKey` as the client *name*, so accept both.
function clientName(query) {
    return (query.name || query.publicKey || '').trim();
}

async function setPeerState(res, query, enabled) {
    const name = clientName(query);
    try {
        const result = await peers[enabled ? 'enable' : 'disable'](name);
        logger.info(enabled ? 'enabled peer' : 'disabled peer', name,
                    'changed=' + result.changed, 'applied=' + result.applied);
        sendJson(res, 200, { success: true, ...result });
    } catch (e) {
        logger.error('setPeerState failed', name, e.message);
        sendJson(res, e.code || 500, { success: false, msg: e.message });
    }
}

async function peerStatus(res, query) {
    const name = clientName(query);
    try {
        sendJson(res, 200, { success: true, ...(await peers.status(name)) });
    } catch (e) {
        sendJson(res, e.code || 500, { success: false, msg: e.message });
    }
}

async function peerList(res) {
    try {
        const [list, usage] = await Promise.all([
            peers.list(),
            traffic.all().catch(() => ({})),   // اگر ترافیک خطا داد، لیست خالی نشود
        ]);

        const merged = list.map(p => {
            const t = usage[p.name];
            return {
                ...p,
                rx: t ? t.rx : 0,
                tx: t ? t.tx : 0,
                total: t ? t.total : 0,
                lastHandshake: t ? t.lastHandshake : 0,
            };
        });

        sendJson(res, 200, { success: true, peers: merged });
    } catch (e) {
        sendJson(res, 500, { success: false, msg: e.message });
    }
}


async function checkToken(req,res,query){
    // res.write('hello');
    let file_is_exist = await  fs.existsSync("/root/wg0-client-"+query.publicKey+".conf")
    if (file_is_exist){
        await res.write('true')
    }else{
        await res.write('false')
    }
}

async function addVpn(req, res, query){

    let myip =await findIp()
    await sleep(2222)
    await logger.info('my ip is here', privateIP)
  
  let file_is_exist = await  fs.existsSync("/root/wg0-client-"+query.publicKey+".conf")
      logger.info('1',file_is_exist)
      
      

  if (!file_is_exist) {
      
      const result =await shell.exec('/home/wire/wireguard-install.sh', { async: true });
      result.stdin.write('1\n'); // Enter 1
      result.stdin.write(query.publicKey+'\n'); // Enter name 'ali'
      result.stdin.write(privateIP+'\n');
      result.stdin.write(privateIP+'\n');
      // result.stdin.write('1\n'); // Press Enter
     result.stdin.end();
      await sleep(2222)
      let _file = "";
       const filePath = "/root/wg0-client-"+query.publicKey+".conf"; // Replace with the actual file path
         let file_is_existss = await  fs.existsSync("/root/wg0-client-"+query.publicKey+".conf")
          logger.info('2',file_is_existss)
// Read the file using ShellJS cat command
    const _result =await shell.exec('cat '+filePath+'\n');
    
    logger.info('catttttt',`cat ${filePath}`)
    
    logger.info('catttttt',_result)
// Check if the command executed successfully
if (_result.code === 0) {
  const fileContent = _result.stdout;

  // Print the file content
  console.log(fileContent);
         res.write(fileContent)
 
}else{
    res.write('hello dfdsf')
}  

  } else {
        await sleep(2000)
      let _file = "";
       const filePath = "/root/wg0-client-"+query.publicKey+".conf"; // Replace with the actual file path
         let file_is_existss = await  fs.existsSync("/root/wg0-client-"+query.publicKey+".conf")
          logger.info('2',file_is_existss)
// Read the file using ShellJS cat command
    const _result =await shell.exec('cat '+filePath+'\n');
    
    logger.info('catttttt',`cat ${filePath}`)
    
    logger.info('catttttt',_result)
// Check if the command executed successfully
if (_result.code === 0) {
  const fileContent = _result.stdout;

  // Print the file content
  console.log(fileContent);
         res.write(fileContent)
 
}
      logger.info('oor is here')
       

  }


  

    
}









async function removeVpn(req, res, query){

 const result = shell.exec('/home/wire/wireguard-install.sh', { async: true });

  
  result.stdin.write('3\n'); // Enter 1
   
  let selecteduser ;
   result.stdout.on('data', (data) => {
 logger.info('Console response:', data.toString());
 
//  const regex = /(\d+)\) ali/;
 const regex = new RegExp(`(\\d+)\\) ${query.publicKey}`);
const matches = regex.exec(data.toString());

if (matches && matches[1]) {
  const numberBeforeAli = parseInt(matches[1]);
  selecteduser =  logger.info('Number before "ali":', numberBeforeAli);
    
  logger.info('selecteduser',parseInt(numberBeforeAli)+'\n')
// result.stdin.write(parseInt(numberBeforeAli)+'\n'); // Enter name 'ali'
  result.stdin.write(numberBeforeAli+'\n'); // Enter name 'ali'
} else {
  logger.info('No match found for the pattern');
}
 
 
 
});

 
//   result.stdin.write(query.publicKey+'\n'); // Enter name 'ali'
  
logger.on('close', (code) => {
  console.log('Command exited with code:', code);
});
  result.stdin.end();
}






async function listUser(req, res, query){

 const result = shell.exec('/home/wire/wireguard-install.sh', { async: true });
    let _listuser ;
  
  result.stdin.write('2\n'); // Enter 1
   
     result.stdout.on('data',async (data) => {
    _listuser =await data.toString()


 
});
  

  result.stdin.end();
 await sleep(2000)
  logger.info('Console response:', _listuser);
  await res.write(_listuser)
}
 


 








