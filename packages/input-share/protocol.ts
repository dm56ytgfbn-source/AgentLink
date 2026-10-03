import { z } from 'zod';
export const deviceSchema = z.enum(['windows', 'mac']);
export type Side = z.infer<typeof deviceSchema>;
export const edgeSchema = z.enum(['left', 'right', 'top', 'bottom']);
export type Edge = z.infer<typeof edgeSchema>;
const coord = z.number().finite().min(-100000).max(100000);
export const displaySchema = z.object({ id:z.string().min(1).max(200), x:coord, y:coord,
 width:z.number().positive().max(50000), height:z.number().positive().max(50000) }).strict();
export type Display = z.infer<typeof displaySchema>;
export const displaysSchema = z.array(displaySchema).min(1).max(32).refine(a=>new Set(a.map(d=>d.id)).size===a.length);
const endpoint = z.object({ device:deviceSchema, display:z.string().min(1).max(200), edge:edgeSchema }).strict();
export const layoutSchema = z.object({ links:z.array(z.object({ from:endpoint,to:endpoint }).strict()).max(32),
 speed:z.number().min(0.1).max(5).default(1), cooldown_ms:z.number().int().min(100).max(2000).default(350) }).strict();
export type Layout = z.infer<typeof layoutSchema>;
export const inputSchema = z.discriminatedUnion('kind', [
 z.object({kind:z.literal('move'),x:coord,y:coord,dx:coord,dy:coord,held:z.number().int().min(0).max(512)}).strict(),
 z.object({kind:z.literal('key'),code:z.number().int().min(0).max(511),down:z.boolean()}).strict(),
 z.object({kind:z.literal('button'),button:z.number().int().min(0).max(4),down:z.boolean()}).strict(),
 z.object({kind:z.literal('scroll'),dx:z.number().finite().min(-10000).max(10000),dy:z.number().finite().min(-10000).max(10000)}).strict(),
]);
export type Input = z.infer<typeof inputSchema>;
export type Point = {x:number;y:number};
export type Mode = 'local'|'remote'|'receive';
export type Command = {t:'mode';epoch:number;mode:Mode;point?:Point} | {t:'input';epoch:number;e:Input} | {t:'ping'} | {t:'stop'};
export const nativeMessageSchema = z.discriminatedUnion('t',[
 z.object({t:z.literal('ready'),displays:displaysSchema,permissions:z.boolean()}).strict(),
 z.object({t:z.literal('ack'),epoch:z.number().int().nonnegative()}).strict(),
 z.object({t:z.literal('event'),epoch:z.number().int().nonnegative(),e:inputSchema}).strict(),
 z.object({t:z.literal('panic'),reason:z.string().max(300)}).strict(),
]);
export type NativeMessage = z.infer<typeof nativeMessageSchema>;
export const commandSchema = z.discriminatedUnion('t',[
 z.object({t:z.literal('mode'),epoch:z.number().int().nonnegative(),mode:z.enum(['local','remote','receive']),point:z.object({x:coord,y:coord}).strict().optional()}).strict(),
 z.object({t:z.literal('input'),epoch:z.number().int().nonnegative(),e:inputSchema}).strict(),
 z.object({t:z.literal('ping')}).strict(),z.object({t:z.literal('stop')}).strict()
]);
export const VERSION = 1;
