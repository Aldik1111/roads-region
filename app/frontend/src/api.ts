import type { Photo } from './types';
export class ApiError extends Error{code:string;details:unknown;constructor(message:string,code='NETWORK_ERROR',details?:unknown){super(message);this.code=code;this.details=details}}
async function request<T>(path:string,options:RequestInit={}):Promise<T>{
 let response:Response;
 try{response=await fetch('/api'+path,{credentials:'include',...options})}catch{throw new ApiError('Не удалось связаться с сервером. Проверьте соединение и повторите попытку.')}
 const data=await response.json().catch(()=>null);
 if(!response.ok){const error=data?.detail&&typeof data.detail==='object'&&!Array.isArray(data.detail)?data.detail:data;throw new ApiError(error?.message|| (response.status===401?'Войдите в систему.':response.status===422?'Проверьте обязательные поля.':'Не удалось выполнить действие.'),error?.code||String(response.status),error?.details)}
 return data as T;
}
export const api={get:<T>(path:string)=>request<T>(path),post:<T>(path:string,body?:unknown,headers:Record<string,string>={})=>request<T>(path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)})};
export async function upload(file:File):Promise<Photo>{const data=new FormData();data.append('file',file);return request<Photo>('/files',{method:'POST',body:data})}
