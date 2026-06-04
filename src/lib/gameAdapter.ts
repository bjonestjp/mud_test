import { DemoAdapter } from "./demoAdapter";
import { createSupabaseGameAdapter, hasSupabaseConfig } from "./supabase";
import type { GameAdapter } from "../types";

export function createGameAdapter(): GameAdapter {
  return hasSupabaseConfig() ? createSupabaseGameAdapter() : new DemoAdapter();
}
