import {useEffect,useState} from 'react';
import {formatDate} from './components';
import type {Defect} from './types';
const local=(v?:string|null)=>{if(!v)return '';const d=new Date(v);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)};
export default function ReviewDeadline({defect,onChange,busy=false}:{defect:Defect;onChange?:(action:string,payload:Record<string,unknown>)=>Promise<void>;busy?:boolean}){
 const [date,setDate]=useState(local(defect.review_due_at)),[reason,setReason]=useState('');
 useEffect(()=>{setDate(local(defect.review_due_at));setReason('')},[defect.id,defect.review_due_at]);
 if(defect.status!=='review')return null;
 return <div className={`review-deadline ${defect.review_overdue?'overdue':''}`}><b>{defect.review_overdue?'Просрочена проверка ремонта':'Срок проверки ремонта'}</b><p>{defect.review_due_at?formatDate(defect.review_due_at):'Для старого отчёта срок не установлен'}</p>{onChange&&<details><summary>Изменить срок проверки</summary><label className="field">Проверить до<input className="input" type="datetime-local" value={date} onChange={e=>setDate(e.target.value)} /></label><label className="field">Причина изменения<textarea className="textarea" value={reason} onChange={e=>setReason(e.target.value)} /></label><button className="button secondary" disabled={busy||!date||reason.trim().length<2} onClick={()=>void onChange('change_review_deadline',{review_due_at:new Date(date).toISOString(),reason:reason.trim()})}>Сохранить срок проверки</button></details>}</div>
}
