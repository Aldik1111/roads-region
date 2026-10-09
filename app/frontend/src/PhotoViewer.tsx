import {useEffect,useRef,useState} from 'react';
import type {Photo} from './types';
import './photo-viewer.css';
export default function PhotoViewer({photos}:{photos:Photo[]}){
 const [selected,setSelected]=useState<Photo|null>(null),[zoom,setZoom]=useState(1);const dialog=useRef<HTMLDialogElement>(null);
 useEffect(()=>{if(selected){setZoom(1);dialog.current?.showModal()}else dialog.current?.close()},[selected]);
 return <>{photos.length?<div className="photo-grid">{photos.map(photo=><button type="button" className="photo photo-zoom-trigger" key={photo.id} onClick={()=>setSelected(photo)} aria-label={`Увеличить фото: ${photo.name||'Фотография'}`}><img src={photo.url} alt={photo.name||'Фотография'} loading="lazy"/><span>Увеличить фото ↗</span></button>)}</div>:<div className="photo-empty">Фотографий пока нет</div>}<dialog ref={dialog} className="photo-viewer" onClose={()=>setSelected(null)} onClick={e=>{if(e.target===e.currentTarget)setSelected(null)}} aria-label="Просмотр фотографии">{selected&&<><header><b>{selected.name||'Фотография'}</b><button className="button secondary small" onClick={()=>setSelected(null)}>Закрыть</button></header><label>Масштаб {zoom.toFixed(1)}×<input aria-label="Масштаб фотографии" type="range" min="1" max="4" step="0.25" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/></label><div className="photo-viewer-image"><img src={selected.url} alt={selected.name||'Фотография'} style={{width:`${zoom*100}%`}}/></div><a href={selected.url} target="_blank" rel="noreferrer">Открыть оригинал</a></>}</dialog></>
}
