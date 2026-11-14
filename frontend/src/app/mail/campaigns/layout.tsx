"use client";

import { Send } from "lucide-react";
import UserShell from "@/components/UserShell";

export default function CampaignsLayout({ children }: { children: React.ReactNode }) {
  return (
    <UserShell>
      {(me) =>
        me.can_campaign ? children : (
          <div className="mx-auto max-w-lg rounded-xl border border-border bg-surface p-6 text-center">
            <Send className="mx-auto mb-3 h-6 w-6 text-muted" />
            <h1 className="font-semibold">Campaigns are not enabled for your mailbox</h1>
            <p className="mt-1 text-sm text-muted">Ask your administrator to allow campaigns for {me.email}.</p>
          </div>
        )
      }
    </UserShell>
  );
}
