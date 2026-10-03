'use client';
import {usePathname} from 'next/navigation';
export default function AccountNav(){const path=usePathname();if(['/login','/privacy','/terms','/setup'].includes(path))return null;return <form className="ml-auto" action="/api/auth/logout" method="post"><button className="text-sm text-slate-400">Sign out</button></form>;}
