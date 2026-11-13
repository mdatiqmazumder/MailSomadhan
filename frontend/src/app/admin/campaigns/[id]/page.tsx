"use client";

import { CampaignDetail } from "@/components/CampaignDetail";

export default function Page() {
  return <CampaignDetail base="/admin" backHref="/admin/campaigns" admin />;
}
