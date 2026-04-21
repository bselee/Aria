"use client";

import React from "react";
import { useEffect, useState } from "react";
import { createBrowserClient } from "@/lib/supabase";
import { Heart, Clock, AlertTriangle, CheckCircle2, XCircle } from "lucide-react";

type AgentHeartbeat = {
  id: string;
  agent_name: string;
  heartbeat_at: string;
  status: "healthy" | "degraded" | "starting" | "stopped";
  metadata: Record<string, any>;
};

type Skill = {
  id: string;
  name: string;
  description: string;
  trigger: string;
  agent_name: string;
  confidence: number;
  times_invoked: number;
  times_succeeded: number;
  created_at: string;
  review_status: "pending" | "approved" | "rejected";
};

const STATUS_CONFIG = {
  healthy: { color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/20", dot: "bg-emerald-500", label: "Healthy", icon: CheckCircle2 },
  degraded: { color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/20", dot: "bg-amber-400", label: "Degraded", icon: AlertTriangle },
  starting: { color: "text-sky-400", bg: "bg-sky-500/10 border-sky-500/20", dot: "bg-sky-500", label: "Starting", icon: Clock },
  stopped: { color: "text-rose-400", bg: "bg-rose-500/10 border-rose-500/20", dot: "bg-rose-500", label: "Stopped", icon: XCircle },
};

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function AgentStatusCard({ agent }: { agent: AgentHeartbeat }) {
  const cfg = STATUS_CONFIG[agent.status];
  const Icon = cfg.icon;
  const currentTask = agent.metadata?.currentTask as string | undefined;

  return (
    <div className={`p-3 rounded-lg border ${cfg.bg}`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <Heart className={`w-4 h-4 ${cfg.color}`} />
          <span className="text-sm font-semibold text-zinc-200">{agent.agent_name}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${cfg.dot} ${agent.status === "healthy" ? "" : agent.status === "stopped" ? "animate-pulse" : ""}`} />
          <span className={`text-[10px] font-mono uppercase tracking-wider ${cfg.color}`}>{cfg.label}</span>
        </div>
      </div>
      {currentTask && (
        <div className="text-xs text-zinc-500 font-mono truncate mb-1">
          {currentTask}
        </div>
      )}
      <div className="text-[10px] text-zinc-600 font-mono flex items-center gap-1">
        <Icon className="w-3 h-3" />
        {timeAgo(agent.heartbeat_at)}
      </div>
    </div>
  );
}

function SkillCard({ skill }: { skill: Skill }) {
  const confidencePct = Math.round((skill.confidence || 0) * 100);
  const successRate = skill.times_invoked > 0
    ? Math.round((skill.times_succeeded / skill.times_invoked) * 100)
    : null;

  return (
    <div className="p-3 rounded-lg bg-zinc-800/40 border border-zinc-700/40 hover:border-zinc-600/60 transition-colors">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="text-sm font-semibold text-zinc-200">{skill.name}</div>
          {skill.description && (
            <div className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{skill.description}</div>
          )}
        </div>
        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 uppercase tracking-wider shrink-0 ml-2">
          Pending
        </span>
      </div>
      <div className="flex items-center gap-3 text-[10px] font-mono text-zinc-600">
        <span className="text-zinc-500">trigger: <span className="text-zinc-400">{skill.trigger}</span></span>
        <span>agent: <span className="text-zinc-400">{skill.agent_name}</span></span>
        <span>confidence: <span className={confidencePct >= 80 ? "text-emerald-400" : confidencePct >= 50 ? "text-amber-400" : "text-rose-400"}>{confidencePct}%</span></span>
        {successRate !== null && (
          <span>success: <span className={successRate >= 80 ? "text-emerald-400" : "text-amber-400"}>{successRate}%</span></span>
        )}
      </div>
    </div>
  );
}

function AgentStatusGrid({ agents }: { agents: AgentHeartbeat[] }) {
  if (agents.length === 0) {
    return (
      <div className="text-center py-8 text-xs font-mono text-zinc-600">
        No agent heartbeats recorded
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {agents.map(agent => (
        <AgentStatusCard key={agent.id} agent={agent} />
      ))}
    </div>
  );
}

function PendingSkillsReview({ skills }: { skills: Skill[] }) {
  if (skills.length === 0) {
    return (
      <div className="text-center py-8 text-xs font-mono text-zinc-600">
        No pending skills for review
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {skills.map(skill => (
        <SkillCard key={skill.id} skill={skill} />
      ))}
    </div>
  );
}

export function OversightPanel() {
  const [agents, setAgents] = useState<AgentHeartbeat[]>([]);
  const [pendingSkills, setPendingSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    const supabase = createBrowserClient();

    const [agentsRes, skillsRes] = await Promise.all([
      supabase
        .from("agent_heartbeats")
        .select("*")
        .order("heartbeat_at", { ascending: false }),
      supabase
        .from("skills")
        .select("*")
        .eq("review_status", "pending")
        .eq("archived", false)
        .order("created_at", { ascending: false }),
    ]);

    if (agentsRes.data) setAgents(agentsRes.data);
    if (skillsRes.data) setPendingSkills(skillsRes.data);
    setLoading(false);
  };

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="space-y-4 p-4">
        <div className="skeleton-shimmer h-6 w-32" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="skeleton-shimmer h-24 rounded-lg" />
          ))}
        </div>
        <div className="skeleton-shimmer h-6 w-32 mt-6" />
        <div className="space-y-2">
          {[1, 2].map(i => (
            <div key={i} className="skeleton-shimmer h-20 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Agent Status</h2>
        <span className="text-[10px] font-mono text-zinc-600">{agents.length} agent{agents.length !== 1 ? "s" : ""}</span>
      </div>
      <AgentStatusGrid agents={agents} />
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300 uppercase tracking-wider">Pending Skills</h2>
        <span className="text-[10px] font-mono text-zinc-600">{pendingSkills.length} awaiting review</span>
      </div>
      <PendingSkillsReview skills={pendingSkills} />
    </div>
  );
}

export default OversightPanel;
