import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {importText} from '../publisher/ingest/importer.mjs';

test('the actual Lua addon produces private, timestamped snapshots accepted by the publisher',async()=>{
  const folder=await mkdtemp('/tmp/auction-addon-');
  try {
    const file=join(folder,'AuctionLedger.lua');
    const partialFile=join(folder,'StoppedAuctionLedger.lua');
    const pairedFile=join(folder,'PairedAuctionLedger.lua');
    const largeFile=join(folder,'LargeAuctionLedger.lua');
    const output=execFileSync('lua5.1',['tests/addon.test.lua',file,partialFile,pairedFile,largeFile],{encoding:'utf8'});
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
  }finally{await rm(folder,{recursive:true,force:true});}
});
