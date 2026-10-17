/**
 * Five-minute signed-in idle DAPI counts on /feed and /messages (devnet only).
 * Run after build:devnet and serve-static; set E2E_DEVNET_SEED_PHRASE securely.
 * node scripts/measure-idle-dapi.mjs http://localhost:3000/devnet after
 * Output contains counts only. No traces or credential values are recorded.
 */
import { chromium } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { deriveIdentityKeys, loadMnemonic, readEnvFile } from './derive-identities.mjs'
import { createHash, hkdfSync } from 'node:crypto'
import bs58check from 'bs58check'
import { getPublicKey } from '@noble/secp256k1'
const base = process.argv[2]
if (!new URL(base).pathname.endsWith('/devnet')) throw new Error('Devnet only')
const label = process.argv[3] || 'measurement'
if (!/^[a-z0-9_-]+$/i.test(label)) throw new Error('Use an alphanumeric result label')
const env = readEnvFile(process.env.E2E_ENV_FILE || '.env.devnet')
if (env.NEXT_PUBLIC_NETWORK !== 'devnet') throw new Error('Devnet environment required')
const mnemonic = loadMnemonic('E2E_DEVNET_SEED_PHRASE')
const identityId = env.E2E_IDENTITY_IDS.split(',')[1]
const auth = deriveIdentityKeys(1, mnemonic).find(k => k.keyIndex === 2)
const anchor = env.NEXT_PUBLIC_LOGIN_PROTOCOL === 'app-connect' ? env.NEXT_PUBLIC_APP_CONNECT_APP_ID : null
const authBytes=bs58check.decode(auth.wif).slice(1,33)
const encPriv=anchor
 ? new Uint8Array(hkdfSync('sha256',authBytes,createHash('sha256').update(identityId).digest(),`yappr/app-connect/encryption-key/v1:${anchor}`,32))
 : bs58check.decode(deriveIdentityKeys(1,mnemonic).find(k=>k.keyIndex===4).wif).slice(1,33)
const encWif=bs58check.encode(new Uint8Array([0xef,...encPriv,1]))
const encHex=Buffer.from(getPublicKey(encPriv,true)).toString('hex')
const browser = await chromium.launch({headless:true})
const results = []
await Promise.all(['/feed/','/messages/'].map(async route => {
 const context = await browser.newContext()
 await context.addInitScript(({identityId,wif,encWif,encHex})=>{
  const scope='devnet:'
  localStorage.setItem(scope+'yappr_session', JSON.stringify({user:{identityId,balance:0,publicKeys:[]},timestamp:Date.now()}))
  localStorage.setItem(scope+`yappr_secure_pk_${identityId}`,JSON.stringify(wif))
  localStorage.setItem(scope+`yappr_secure_ek_${identityId}`,JSON.stringify(encWif))
  if (encHex) localStorage.setItem(scope+`yappr_anchor_ek_${identityId}`,encHex)
  localStorage.setItem(scope+'yappr_starter_grant_settled',JSON.stringify([identityId]))
  sessionStorage.setItem(scope+'yappr_skip_dpns','true')
 },{identityId,wif:auth.wif,encWif,encHex:anchor?encHex:null})
 const page = await context.newPage()
 let phase='startup'
 const counts={startup:{},visible:{},settling:{},hidden:{}}
 let doubles=0
 page.on('request',request=>{
  const url=new URL(request.url())
  if(url.pathname.includes('/org.dash.platform.')) {
   const method=url.pathname.split('/').at(-1)
   counts[phase][method]=(counts[phase][method]||0)+1
   if(url.pathname.startsWith('//')) doubles++
  }
 })
 await page.goto(base+route,{waitUntil:'domcontentloaded',timeout:120000})
 await page.waitForTimeout(60000)
 const signedIn=await page.getByRole('link',{name:'Profile',exact:true}).count()>0
 if (!signedIn) throw new Error(`Session did not restore on ${route}`)
 const started=Date.now()
 phase='visible'
 for(let minute=1;minute<=5;minute++) {
  await page.waitForTimeout(60000)
  console.log(JSON.stringify({label,route,minute,elapsedMs:Date.now()-started,requests:Object.values(counts.visible).reduce((a,b)=>a+b,0)}))
 }
 const visibleDurationMs=Date.now()-started
 phase='settling'
 // A native focus/visibility change is separately verified by unit tests. This
 // deterministic hidden-state event measures the app policy without OS tab focus.
 await page.evaluate(()=>{
  Object.defineProperty(document,'hidden',{configurable:true,get:()=>true})
  Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'})
  document.dispatchEvent(new Event('visibilitychange'))
 })
 await page.waitForTimeout(10000)
 phase='hidden'
 await page.waitForTimeout(60000)
 results.push({label,route,signedIn,visibleDurationMs,counts,doubleSlashRequests:doubles})
 await context.close()
}))
await browser.close()
writeFileSync(`/tmp/yappr-perf-${label}-idle.json`,JSON.stringify(results,null,2))
console.log(JSON.stringify(results))
