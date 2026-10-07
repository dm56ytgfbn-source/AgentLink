// Set-1 PC scan code (+256 for extended) <-> Apple virtual key code, physical positions.
// No text serialization: the receiving OS owns its keyboard layout and IME.
const pairs:number[][]=[
 [30,0],[31,1],[32,2],[33,3],[35,4],[34,5],[44,6],[45,7],[46,8],[47,9],[48,11],[16,12],[17,13],[18,14],[19,15],[21,16],[20,17],
 [2,18],[3,19],[4,20],[5,21],[7,22],[6,23],[13,24],[10,25],[8,26],[12,27],[9,28],[11,29],[27,30],[24,31],[22,32],[26,33],[23,34],[25,35],
 [28,36],[38,37],[36,38],[40,39],[37,40],[39,41],[43,42],[51,43],[53,44],[49,45],[50,46],[52,47],[15,48],[57,49],[41,50],[14,51],[1,53],
 [347,55],[348,54],[42,56],[58,57],[56,58],[29,59],[54,60],[312,61],[285,62],
 [83,65],[55,67],[78,69],[69,71],[309,75],[284,76],[74,78],[82,82],[79,83],[80,84],[81,85],[75,86],[76,87],[77,88],[71,89],[72,91],[73,92],
 [59,122],[60,120],[61,99],[62,118],[63,96],[64,97],[65,98],[66,100],[67,101],[68,109],[87,103],[88,111],
 [338,114],[327,115],[329,116],[339,117],[335,119],[337,121],[331,123],[333,124],[336,125],[328,126],[86,10]
];
const toMac=new Map(pairs.map(([a,b])=>[a,b])), toWindows=new Map(pairs.map(([a,b])=>[b,a]));
export type InputPlatform = 'win32' | 'darwin';
export function translateKeyBetween(source:InputPlatform,target:InputPlatform,code:number){
 return source===target?code:translateKey(source==='win32'?'windows':'mac',code);
}
export function translateKey(source:'windows'|'mac',code:number) { return (source==='windows'?toMac:toWindows).get(code); }
