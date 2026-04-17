/**
 * @file    skill-crystallizer.ts
 * @purpose Converts agent execution traces into reusable, reviewable skills.
 *          Crystallized skills are stored in the `skills` table and can be
 *          approved/rejected by a supervisor before being matched to future tasks.
 * @author  Will / Antigravity
 * @created 2026-04-17
 */

import { createClient } from "@/lib/supabase";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SkillStep {
    order: number;
    action: "tool_call" | "llm_call" | "db_query" | "api_call" | "wait" | "decision";
    name: string;
    params: Record<string, unknown>;
    result_pattern?: string;
    error_pattern?: string;
}

export interface CrystallizeRequest {
    agentName: string;
    taskType: string;
    inputSummary: string;
    outputSummary: string;
    executionTrace: SkillStep[];
}

export interface Skill {
    id: string;
    agent_name: string;
    task_type: string;
    input_summary: string;
    output_summary: string;
    execution_trace: SkillStep[];
    review_status: "pending" | "approved" | "rejected";
    rejection_feedback?: string | null;
    archived: boolean;
    created_at: string;
    approved_at?: string | null;
}

// ── Keyword matching ──────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 2);
}

function keywordScore(trigger: string, skill: Skill): number {
    const triggerTokens = new Set(tokenize(trigger));
    if (triggerTokens.size === 0) return 0;

    const skillTokens = new Set([
        ...tokenize(skill.task_type),
        ...tokenize(skill.input_summary),
        ...tokenize(skill.output_summary),
    ]);

    let overlap = 0;
    for (const tok of triggerTokens) {
        if (skillTokens.has(tok)) overlap++;
    }

    return overlap / triggerTokens.size;
}

// ── SkillCrystallizer ─────────────────────────────────────────────────────────

export class SkillCrystallizer {
    async crystallize(request: CrystallizeRequest): Promise<string> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from("skills")
            .insert({
                agent_name: request.agentName,
                task_type: request.taskType,
                input_summary: request.inputSummary,
                output_summary: request.outputSummary,
                execution_trace: request.executionTrace,
                review_status: "pending",
                archived: false,
            })
            .select("id")
            .single();

        if (error) throw new Error(`SkillCrystallizer.crystallize failed: ${error.message}`);

        return data.id;
    }

    async getPendingSkills(): Promise<Skill[]> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from("skills")
            .select("*")
            .eq("review_status", "pending")
            .eq("archived", false)
            .order("created_at", { ascending: false });

        if (error) throw new Error(`SkillCrystallizer.getPendingSkills failed: ${error.message}`);

        return (data as Skill[]) ?? [];
    }

    async approveSkill(skillId: string): Promise<void> {
        const supabase = createClient();

        const { error } = await supabase
            .from("skills")
            .update({
                review_status: "approved",
                approved_at: new Date().toISOString(),
            })
            .eq("id", skillId);

        if (error) throw new Error(`SkillCrystallizer.approveSkill failed: ${error.message}`);
    }

    async rejectSkill(skillId: string, feedback: string): Promise<void> {
        const supabase = createClient();

        const { error } = await supabase
            .from("skills")
            .update({
                review_status: "rejected",
                rejection_feedback: feedback,
            })
            .eq("id", skillId);

        if (error) throw new Error(`SkillCrystallizer.rejectSkill failed: ${error.message}`);
    }

    async findMatchingSkill(trigger: string): Promise<Skill | null> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from("skills")
            .select("*")
            .eq("review_status", "approved")
            .eq("archived", false);

        if (error) throw new Error(`SkillCrystallizer.findMatchingSkill failed: ${error.message}`);

        const skills = (data as Skill[]) ?? [];
        let best: Skill | null = null;
        let bestScore = 0;

        for (const skill of skills) {
            const score = keywordScore(trigger, skill);
            if (score > bestScore && score >= 0.3) {
                bestScore = score;
                best = skill;
            }
        }

        return best;
    }
}
