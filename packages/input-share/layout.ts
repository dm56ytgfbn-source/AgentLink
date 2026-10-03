import type {Display, Edge, Layout, Point, Side} from './protocol.js';
export type Screens = Record<Side,Display[]>;
export const opposite = (edge:Edge):Edge => ({left:'right',right:'left',top:'bottom',bottom:'top'} as const)[edge];
export function contains(d:Display,p:Point) { return p.x>=d.x&&p.y>=d.y&&p.x<d.x+d.width&&p.y<d.y+d.height; }
export function clamp(screens:Display[],p:Point):Point {
 let best:Point|undefined, distance=Infinity;
 for(const d of screens){const q={x:Math.min(d.x+d.width-1,Math.max(d.x,p.x)),y:Math.min(d.y+d.height-1,Math.max(d.y,p.y))};const dist=(p.x-q.x)**2+(p.y-q.y)**2;if(dist<distance){best=q;distance=dist;}}
 if(!best)throw Error('No displays');return best;
}
// Where the Mac sits relative to the Windows computer. Only the direction crosses the wire:
// the machine being used already knows both display lists, so it is the one that can turn a
// direction into concrete display edges and coordinates.
export type MacPosition = 'left' | 'right' | 'top' | 'bottom';
export function layoutFor(screens:Screens, macPosition:MacPosition):Layout {
 const horizontal=macPosition==='left'||macPosition==='right';
 const windows=[...screens.windows].sort(horizontal
  ? (a,b)=>(macPosition==='right'?(b.x+b.width)-(a.x+a.width):a.x-b.x)||a.y-b.y
  : (a,b)=>(macPosition==='bottom'?(b.y+b.height)-(a.y+a.height):a.y-b.y)||a.x-b.x)[0];
 const mac=[...screens.mac].sort(horizontal
  ? (a,b)=>(macPosition==='right'?a.x-b.x:(b.x+b.width)-(a.x+a.width))||a.y-b.y
  : (a,b)=>(macPosition==='bottom'?a.y-b.y:(b.y+b.height)-(a.y+a.height))||a.x-b.x)[0];
 return {links:[{from:{device:'windows',display:windows.id,edge:macPosition},
   to:{device:'mac',display:mac.id,edge:opposite(macPosition)}}],speed:1,cooldown_ms:350};
}
export function defaultLayout(screens:Screens):Layout { return layoutFor(screens,'right'); }
export function validateLayout(layout:Layout,screens:Screens) {
 const used=new Set<string>();
 for(const link of layout.links){
  if(link.from.device===link.to.device)throw Error('A portal must connect different computers');
  if(opposite(link.from.edge)!==link.to.edge)throw Error('Portal edges must face each other');
  for(const end of [link.from,link.to]){if(!screens[end.device].some(d=>d.id===end.display))throw Error('Display missing: '+end.display);
   const key=JSON.stringify(end);if(used.has(key))throw Error('Ambiguous display edge');used.add(key);}
 }
}
// Coordinates stay in each OS's desktop space: Windows physical pixels, macOS Quartz points.
// Only the edge fraction crosses devices; unlike a single huge desktop this handles mixed DPI.
export function crossing(layout:Layout,screens:Screens,side:Side,p:Point,dx:number,dy:number) {
 for(const l of layout.links){const from=l.from.device===side?l.from:l.to;const to=l.from.device===side?l.to:l.from;
  const d=screens[side].find(d=>d.id===from.display)!;
  const vertical=from.edge==='left'||from.edge==='right';
  const along=vertical?p.y:p.x, start=vertical?d.y:d.x, extent=vertical?d.height:d.width;
  if(along<start||along>=start+extent)continue;
  const at=from.edge==='left'?p.x<=d.x+1&&p.x>=d.x-500&&dx<0:
   from.edge==='right'?p.x>=d.x+d.width-2&&p.x<=d.x+d.width+500&&dx>0:
   from.edge==='top'?p.y<=d.y+1&&p.y>=d.y-500&&dy<0:p.y>=d.y+d.height-2&&p.y<=d.y+d.height+500&&dy>0;
  if(!at)continue;
  const outside={x:vertical?(from.edge==='left'?d.x-0.5:d.x+d.width+0.5):along,
   y:vertical?along:(from.edge==='top'?d.y-0.5:d.y+d.height+0.5)};
  // Never switch at a join between monitors on the same machine.
  if(screens[side].some(other=>other.id!==d.id&&contains(other,outside)))continue;
  const dest=screens[to.device].find(d=>d.id===to.display)!;
  const f=Math.max(0,Math.min(1,(along-start)/Math.max(1,extent-1)));
  const point=vertical?{x:to.edge==='left'?dest.x+3:dest.x+dest.width-4,y:dest.y+f*(dest.height-1)}:
   {x:dest.x+f*(dest.width-1),y:to.edge==='top'?dest.y+3:dest.y+dest.height-4};
  return {side:to.device,point:clamp(screens[to.device],point)};
 }
 return null;
}
