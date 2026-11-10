import type { FastifyInstance } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { getMemoryPolicy,setMemoryPolicy } from '../../core/memory/rhythm.ts';
export function registerMemoryPolicyRoutes(app:FastifyInstance,{db}:{db:DatabaseSync}):void {
 const base='/api/projects/:id/memory/policy';
 app.get<{Params:{id:string}}>(base,async request=>getMemoryPolicy(db,request.params.id));
 app.patch<{Params:{id:string};Body:unknown}>(base,async request=>setMemoryPolicy(db,request.params.id,request.body));
}
