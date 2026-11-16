import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {analyze} from './reference-analysis.mjs';
import {marketKey,mergeSnapshots} from '../publisher/ingest/market.mjs';
const binary=resolve('publisher/target/release/auction-publisher');
const built=existsSync(binary);
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();

test('Rust reports match the existing measured market calculations and are deterministic',{skip:!built},async()=>{
  const output=await mkdtemp('/tmp/auction-report-test-');
  try {
    const index=JSON.parse(await readFile('data/history.json'));
    const snapshots=await Promise.all(index.snapshots.map(entry=>readFile(entry.file).then(JSON.parse)));
    const alias=snapshots.find(s=>s.source==='Auction Ledger'&&s.faction!=='Neutral');
    if(alias)snapshots.push({...alias,realm:'Another label',faction:'Horde'});
    const history={version:1,snapshots:mergeSnapshots(snapshots)};
    const input=join(output,'input.json');await writeFile(input,JSON.stringify({version:1,snapshots}));
    execFileSync(binary,['--build',input,output]);
    const manifest=JSON.parse(await readFile(join(output,'trends.json')));
    const original=await readFile(join(output,'trends.json'),'utf8');

    for(const market of manifest.markets)for(const days of [1,7,30,36500]){
      const expected=analyze(history.snapshots.filter(s=>marketKey(s)===market.key),days);
      const actual=JSON.parse(await readFile(join(output,market.periods[days].slice(5))));
      assert.equal(actual.basketSize,expected.basketSize);
      assert.equal(actual.baseline.timestamp,expected.baseline.timestamp);
      assert.equal(actual.items.length,expected.items.length);
      const byKey=new Map(actual.items.map(i=>[i.key,i]));
      for(const expectedItem of expected.items){
        const item=byKey.get(expectedItem.key);
        assert.equal(item.reference,expectedItem.reference);assert.equal(item.spread,expectedItem.spread);
        assert.deepEqual(item.history,expectedItem.history);assert.equal(item.supplyChange,expectedItem.supplyChange);
        if(expectedItem.change==null)assert.equal(item.change,null);
        else assert.ok(Math.abs(item.change-expectedItem.change)<1e-9);
      }
      actual.series.forEach((point,index)=>{
        if(expected.series[index].value==null)assert.equal(point.value,null);
        else assert.ok(Math.abs(point.value-expected.series[index].value)<1e-9);
      });
    }
    execFileSync(binary,['--build',input,output]);
    assert.equal(await readFile(join(output,'trends.json'),'utf8'),original);
  }finally{await rm(output,{recursive:true,force:true});}
});

test('daily publisher pushes only sanitized generated files and repeated runs make no commit',{skip:!built},async()=>{
  const folder=await mkdtemp('/tmp/auction-push-test-');
  const source=join(folder,'source'),remote=join(folder,'remote.git'),state=join(folder,'private');
  await mkdir(join(source,'data'),{recursive:true});await mkdir(state);
  const snapshot={realm:'Test',faction:'Alliance',source:'Auctionator cache',timestamp:'2026-01-01T00:00:00.000Z',coverage:'partial',items:[{itemId:13463,key:'13463',name:'Dreamfoil',icon:'inv_misc_herb_dreamfoil',category:'Trade goods',quality:1,minBuyout:100,medianBuyout:100,quantity:10,listings:1}]};
  try{
    git(source,'init','-b','main');git(source,'config','user.name','Publisher test');git(source,'config','user.email','test@example.invalid');
    const bytes=Buffer.from(JSON.stringify(snapshot)),hash=createHash('sha256').update(bytes).digest('hex');
    await mkdir(join(source,'data/history'));
    await writeFile(join(source,`data/history/${hash}.json`),bytes);
    await writeFile(join(source,'data/history.json'),JSON.stringify({version:1,snapshots:[{file:`data/history/${hash}.json`}]}));
    git(source,'add','.');git(source,'commit','-m','Seed');git(folder,'clone','--bare',source,remote);
    const input=join(folder,'scan.csv'),key=join(folder,'fake-key');
    const raw='itemId,name,minBuyout,quantity,realm,faction,timestamp,seller,account\n13463,Dreamfoil,80,5,Test,Alliance,2026-01-02T00:00:00Z,DO_NOT_PUBLISH_SELLER,DO_NOT_PUBLISH_ACCOUNT';
    await writeFile(input,raw);await writeFile(key,'not a real credential');
    const config=join(state,'config.json');
    const addonFolder=join(folder,'game','WTF','Account','FIRST_TEST_ACCOUNT','SavedVariables');
    const secondFolder=join(folder,'game','WTF','Account','SECOND_TEST_ACCOUNT','SavedVariables');
    await mkdir(addonFolder,{recursive:true});await mkdir(secondFolder,{recursive:true});
    const addon=join(addonFolder,'AuctionLedger.lua');
    const second=join(secondFolder,'AuctionLedger.lua');
    const secondRaw='AuctionLedgerDB={version=1,scans={{status="saved",realm="Other Test Realm",faction="Horde",startedAt=1793535300,timestamp=1793535400,captured=1,received=1,variants={{itemId=13463,itemString="item:13463",name="Dreamfoil"}},rows={"1;2;10000;0;0;4"}}}}';
    await writeFile(second,secondRaw);
    execFileSync('lua5.1',['tests/addon.test.lua',join(folder,'legacy.lua'),join(folder,'partial.lua'),addon]);
    const addonBefore=await readFile(addon,'utf8');
    await writeFile(config,JSON.stringify({repository:remote,deployKey:key,inputs:[{path:input},{path:join(folder,'Auctionator.lua')},{path:addon}]}));
    const invoke=()=>spawnSync(binary,['--config',config],{encoding:'utf8'});
    let result=invoke();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Published to main/);
    assert.match(result.stdout,/Scanner files read: 2\./);
    let head=git(remote,'rev-parse','main');
    const files=git(remote,'diff-tree','--no-commit-id','--name-only','-r',head).split('\n');
    assert.ok(files.every(f=>/^data\/(history|reports)\/[a-f0-9]{64}\.json$/.test(f)||['data/trends.json','data/history.json'].includes(f)));
    const archive=git(remote,'show','main:data/history.json');assert.doesNotMatch(archive,/DO_NOT_PUBLISH|scan.csv|fake-key/);
    const manifest=JSON.parse(archive);assert.equal(manifest.snapshots.length,4);
    assert.ok(manifest.snapshots.every(s=>s.source==='Auction Ledger'));
    assert.ok(manifest.snapshots.every(s=>s.realm==='Auction House'&&['Faction','Neutral'].includes(s.faction)));
    const trends=JSON.parse(git(remote,'show','main:data/trends.json'));
    assert.equal(trends.markets.length,2);
    assert.ok(trends.markets.every(m=>m.source==='Auction Ledger'));
    const ownMarket=trends.markets.find(m=>m.source==='Auction Ledger'&&m.faction==='Faction');assert.ok(ownMarket);
    const ownReport=JSON.parse(git(remote,'show',`main:${ownMarket.periods['7']}`));
    assert.equal(ownReport.summary.listedSupply,2);assert.equal(ownReport.items[0].listings,1);
    assert.equal(ownReport.items[0].minBuyout,5000); // The latest other-account scan wins across realm labels.
    assert.match(trends.flips,/^data\/reports\/[a-f0-9]{64}\.json$/);
    const flips=JSON.parse(git(remote,'show',`main:${trends.flips}`));
    assert.equal(flips.pairs.length,1);
    const pair=flips.pairs[0];
    assert.equal(pair.matchedItems,1);assert.equal(pair.items.length,1);
    assert.equal(pair.items[0].direction,'neutral-to-faction');
    assert.equal(pair.items[0].buy,500);assert.equal(pair.items[0].sell,5000);assert.equal(pair.items[0].margin,4250);
    assert.ok(pair.factionScan.timestamp);assert.ok(pair.neutralScan.timestamp);
    for(const entry of manifest.snapshots)assert.doesNotMatch(git(remote,'show',`main:${entry.file}`),/DO_NOT_PUBLISH|seller|account/);
    result=invoke();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/already up to date/);
    assert.equal(git(remote,'rev-parse','main'),head);assert.equal(await readFile(input,'utf8'),raw);
    assert.equal(await readFile(addon,'utf8'),addonBefore);
    assert.equal(await readFile(second,'utf8'),secondRaw);
    const settings=JSON.parse(await readFile(config,'utf8'));settings.flipFees={factionPercent:10,neutralPercent:15};
    await writeFile(config,JSON.stringify(settings));
    result=invoke();assert.equal(result.status,0,result.stderr);
    const adjusted=JSON.parse(git(remote,'show','main:data/trends.json'));
    assert.notEqual(adjusted.revision,trends.revision);assert.notEqual(adjusted.flips,trends.flips);
    const adjustedPair=JSON.parse(git(remote,'show',`main:${adjusted.flips}`)).pairs[0];
    assert.equal(adjustedPair.items[0].margin,4000);head=git(remote,'rev-parse','main');
    await writeFile(join(state,'checkout','unrelated.txt'),'never stage this');
    result=invoke();assert.notEqual(result.status,0);assert.match(result.stderr,/unfinished changes/);
    assert.equal(git(remote,'rev-parse','main'),head);
  }finally{await rm(folder,{recursive:true,force:true});}
});
