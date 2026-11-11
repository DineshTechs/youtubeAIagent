import fs from 'node:fs/promises';
export async function generateMockImage(prompt,outFile){
 const width=720,height=1280; const buf=Buffer.alloc(width*height*3);
 for(let y=0;y<height;y++) for(let x=0;x<width;x++){ const idx=(y*width+x)*3; buf[idx]=255; buf[idx+1]=247; buf[idx+2]=223; }
 const header=Buffer.from(`P6\n${width} ${height}\n255\n`);
 await fs.writeFile(outFile,Buffer.concat([header,buf]));
 return outFile;
}
export async function generateMockSpeech(_text,outFile){await fs.writeFile(outFile,Buffer.alloc(0));return outFile;}
