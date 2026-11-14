// Reassemble Blizzard's eight-piece backdrop strips as CSS nine-slice frames.
// SVG viewports reuse the original PNG pixels; no artwork is repainted.
import {readFile,writeFile} from 'node:fs/promises';
const directory=new URL('../assets/ui/',import.meta.url);
const image=async name=>'data:image/png;base64,'+(await readFile(new URL(name,directory))).toString('base64');
const svg=(width,height,body)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>\n`;
for(const [input,output,size] of [['dialog-border.png','frame-metal.svg',32],['gold-border.png','frame-gold.svg',32],['slider-border.png','frame-inset.svg',8]]){
  const data=await image(input),s=size-4;
  const crop=(tile,x,y,rotate=false)=>`<g transform="translate(${x} ${y})${rotate?` translate(${s} 0) rotate(90)`:''}"><svg width="${s}" height="${s}" viewBox="${tile*size+2} 2 ${s} ${s}"><image href="${data}" width="${size*8}" height="${size}"/></svg></g>`;
  const body=crop(4,0,0)+crop(2,s,0,true)+crop(5,s*2,0)+crop(0,0,s)+crop(1,s*2,s)+crop(6,0,s*2)+crop(3,s,s*2,true)+crop(7,s*2,s*2);
  await writeFile(new URL(output,directory),svg(s*3,s*3,body));
  if(input==='dialog-border.png'){
    await writeFile(new URL('trim-horizontal.svg',directory),svg(s,s,crop(2,0,0,true)));
    await writeFile(new URL('trim-vertical.svg',directory),svg(s,s,crop(0,0,0)));
  }
}
for(const [input,output]of [['button-disabled.png','button-stone.svg'],['stone-down.png','button-stone-down.svg']]){
  await writeFile(new URL(output,directory),svg(78,21,`<image href="${await image(input)}" width="128" height="32"/>`));
}
console.log('Prepared original Blizzard frame and button slices.');
