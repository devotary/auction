import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {importText} from '../publisher/ingest/importer.mjs';

test('the actual Lua addon produces private, timestamped snapshots accepted by the publisher',async()=>{
  const folder=await mkdtemp('/tmp/auction-addon-');
  try {
    const file=join(folder,'AuctionLedger.lua');
    const partialFile=join(folder,'StoppedAuctionLedger.lua');
    const pairedFile=join(folder,'PairedAuctionLedger.lua');
    const largeFile=join(folder,'LargeAuctionLedger.lua');
    const summaryFile=join(folder,'SummaryAuctionLedger.lua');
    const output=execFileSync('lua5.1',['tests/addon.test.lua',file,partialFile,pairedFile,largeFile,summaryFile],{encoding:'utf8'});
    assert.match(output,/PASS: streaming/);
    const raw=await readFile(file);
    assert.doesNotMatch(raw.toString(),/PRIVATE_/);
    const snapshots=importText(raw.toString('latin1'),'AuctionLedger.lua');
    assert.equal(snapshots.length,2);
    const s=snapshots[0];
    assert.equal(s.realm,'Auction House');assert.equal(s.faction,'Faction');assert.equal(s.source,'Auction Ledger');assert.equal(s.coverage,'partial');
    assert.equal(s.items[0].minBuyout,1000);assert.equal(s.items[0].medianBuyout,1000);
    assert.equal(s.items[0].quantity,30);assert.equal(s.items[0].listings,2);
    assert.ok(Date.parse(s.timestamp)>Date.parse('2026-11-01'));
    const partialRaw=await readFile(partialFile);
    assert.doesNotMatch(partialRaw.toString(),/PRIVATE_/);
    const partial=importText(partialRaw.toString('latin1'),'AuctionLedger.lua').at(-1);
    assert.equal(partial.source,'Auction Ledger');assert.equal(partial.coverage,'partial');
    assert.equal(partial.items[0].quantity,5);assert.equal(partial.items[0].listings,1);
    assert.equal(partial.items[0].minBuyout,3000);
    const [large]=importText((await readFile(largeFile)).toString('latin1'),'AuctionLedger.lua');
    assert.equal(large.items.length,25000);
    assert.equal(large.items.reduce((sum,item)=>sum+item.listings,0),300000);
    assert.equal(large.items.reduce((sum,item)=>sum+item.quantity,0),6000000);
    assert.ok(large.items.every(item=>item.minBuyout===1000 && item.medianBuyout===1000));
    const summaryRaw=await readFile(summaryFile,'utf8');
    assert.doesNotMatch(summaryRaw,/PRIVATE_/);
    const summaries=importText(summaryRaw,'AuctionLedger.lua');
    assert.equal(summaries.length,3);
    assert.ok(summaries.every(s=>s.detail==='summary'&&!Object.hasOwn(s,'capture')));
    assert.ok(summaries.flatMap(s=>s.items).every(i=>i.medianBuyout===null&&i.listings===null));
    const latest=summaries.filter(s=>s.faction==='Faction').at(-1);
    const herb=latest.items.find(i=>i.itemId===13463);
    assert.equal(herb.minBuyout,1000);assert.equal(herb.quantity,30);assert.equal(herb.key,'13463:b1:0:0:0');
    const binary='publisher/target/release/auction-publisher';
    if(existsSync(binary)){
      const history=join(folder,'history.json'),reports=join(folder,'reports');
      await writeFile(history,JSON.stringify({version:1,snapshots:summaries}));
      execFileSync(binary,['--build',history,reports],{encoding:'utf8'});
      const manifest=JSON.parse(await readFile(join(reports,'trends.json'),'utf8'));
      const load=async file=>JSON.parse(await readFile(join(reports,file.replace(/^data\//,'')),'utf8'));
      const market=manifest.markets.find(m=>m.faction==='Faction');
      const report=await load(market.periods['7']);
      assert.equal(report.latest.detail,'summary');
      const item=report.items.find(i=>i.itemId===13463);
      assert.equal(item.minBuyout,1000);assert.equal(item.medianBuyout,null);assert.equal(item.listings,null);
      assert.equal(item.activity.quantityBefore,40);assert.equal(item.activity.quantityAfter,30);
      assert.equal(item.activity.unitChange,-10);assert.equal(item.activity.listingsPerHour,null);
      const flips=await load(manifest.flips);
      assert.equal(flips.pairs[0].matchedItems,3);
      const flip=flips.pairs[0].items.find(i=>i.itemId===13463);
      assert.equal(flip.direction,'neutral-to-faction');assert.equal(flip.margin,450);
      assert.equal(flips.pairs[0].items.find(i=>i.itemId===13466).direction,'faction-to-neutral');
    }
  }finally{await rm(folder,{recursive:true,force:true});}
});
