import {execFileSync} from "node:child_process"
import {cycleTimezoneSchema,cyclesSchema,initialTeamCycles} from "../apps/forge/src/lib/team-cycles-contract.ts"
import {addCycleDays,cycleToday,nextCycleDate} from "../apps/forge/src/lib/cycle-calendar.ts"
import {triageSchema,initialTeamTriage} from "../apps/forge/src/lib/team-triage-contract.ts"
const names=JSON.parse(execFileSync("cargo",["run","-p","forge-core","--example","timezone-names","--quiet","--locked"],{encoding:"utf8"}))
export const cycleTimezones={}
for(const name of [...names,"GMT+0","GMT-0","GMT0","Greenwich","Universal","Zulu","UCT","UTC","CST","EST","MST","HST"]){
    const result=cycleTimezoneSchema.safeParse(name)
    if(result.success)cycleTimezones[name.toLowerCase()]=result.data
}
export const cycleCases=[]
function add(kind,input,schema){const result=schema.safeParse(input);cycleCases.push({kind,input,valid:result.success,...(result.success?{expected:result.data}:{})})}
for(const value of [...names,"europe/paris","+02:00","Europe/Paris ","Invalid/Zone","GMT+0","CST"]){add("timezone",value,cycleTimezoneSchema)}
const defaults=initialTeamCycles();add("settings",defaults,cyclesSchema)
for(const field of Object.keys(defaults)){const v={...defaults};delete v[field];add("settings",v,cyclesSchema)}
for(const [field,values] of Object.entries({duration:[0,1,8,9,1.5],cooldown:[-1,0,4,5],startDay:[-1,0,6,7],futureCycles:[0,1,6,7],timezone:["UTC","europe/paris","+02:00"]}))for(const value of values)add("settings",{...defaults,[field]:value},cyclesSchema)
for(const value of [initialTeamTriage(),{enabled:true,requirePriority:true,action:"assign"},{enabled:true,requirePriority:false,action:"notify"},{enabled:true,requirePriority:false,action:"invalid"}])add("triage",value,triageSchema)
export const cycleCalendar={
    today:["UTC","Europe/Paris","America/Los_Angeles","Pacific/Auckland","Asia/Calcutta"].flatMap(zone=>["2026-03-29T22:30:00Z","2026-10-25T00:30:00Z","2026-12-31T23:30:00Z"].map(now=>({zone,now,expected:cycleToday(zone,new Date(now))}))),
    add:["2026-03-23","2026-10-19","2028-02-28","2026-12-31"].flatMap(date=>[-14,0,1,13,55].map(days=>({date,days,expected:addCycleDays(date,days)}))),
    next:["2026-11-02","2026-11-03","2026-12-31"].flatMap(date=>Array.from({length:7},(_,weekday)=>[true,false].map(strict=>({date,weekday,strict,expected:nextCycleDate(date,weekday,strict)}))).flat())
}
