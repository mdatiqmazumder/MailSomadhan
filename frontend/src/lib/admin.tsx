"use client";

import { createContext, useContext } from "react";
import type { AdminMe } from "./api";

export const AdminContext = createContext<AdminMe | null>(null);

/** The signed-in console account and what it may do. */
export function useAdmin() {
  const me = useContext(AdminContext);
  const isSuper = me?.role === "super_admin";
  return {
    me,
    isSuper,
    can: (perm: string) => isSuper || !!me?.permissions.includes(perm),
  };
}
