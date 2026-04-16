import { Request, Response, NextFunction } from 'express';
import { RoleLV } from '../types';
export declare const ROLE_LV: RoleLV;
export declare const requireLogin: (req: Request, res: Response, next: NextFunction) => void;
export declare const requireRole: (roleName: string) => (req: Request, res: Response, next: NextFunction) => void;
//# sourceMappingURL=auth.d.ts.map