import React from 'react';
import {createRoot} from 'react-dom/client';
import RoutePlanner from '../src/RoutePlanner';
import {LocationProvider} from '../src/geolocation';
import type {User} from '../src/types';

const dispatcher:User={id:'dispatcher-test',name:'Test dispatcher',email:'dispatcher@example.invalid',role:'dispatcher'};
createRoot(document.getElementById('root')!).render(<LocationProvider><RoutePlanner user={dispatcher}/></LocationProvider>);
