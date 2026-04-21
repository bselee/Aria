/**
 * @file skill-crystallizer.ts
 * @purpose Stores reviewable skills against the real `skills` schema and tracks
 *          shadow runs plus invocation confidence.
 */

import { createClient } from "@/lib/supabase";

export interface SkillStep {
    order: number;
    action: "tool_call" | "llm_call" | "db_query" | "api_call" | "wait" | "decision";
    name: string;
    params: Record<string, unknown>;
    result_pattern?: string;
    error_pattern?: string;
}

export interface CrystallizeRequest {
    name: string;
    description: string;
    trigger: string;
    agentName: string;
    steps: SkillStep[];
}

export interface Skill {
    id: string;
    name: string;
    description: string;
    trigger: string;
    agent_name: string;
    steps: SkillStep[];
    confidence: number;
    times_invoked: number;
    times_succeeded: number;
    review_status: "pending" | "approved" | "rejected";
    rejection_feedback?: string | null;
    archived: boolean;
    created_at: string;
    updated_at?: string | null;
}

export interface ShadowRunRequest {
    skillId: string;
    agentName: string;
    taskType: string;
    inputSummary: string;
    outputSummary: string;
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((token) => token.length > 2);
}

function keywordScore(trigger: string, skill: Skill): number {
    const triggerTokens = new Set(tokenize(trigger));
    if (triggerTokens.size === 0) return 0;

    const skillTokens = new Set([
        ...tokenize(skill.name),
        ...tokenize(skill.description),
        ...tokenize(skill.trigger),
    ]);

    let overlap = 0;
    for (const token of triggerTokens) {
        if (skillTokens.has(token)) overlap++;
    }

    return overlap / triggerTokens.size;
}

function nextConfidence(timesInvoked: number, timesSucceeded: number): number {
    if (timesInvoked <= 0) return 0;
    return Number((timesSucceeded / timesInvoked).toFixed(4));
}

export class SkillCrystallizer {
    async crystallize(request: CrystallizeRequest): Promise<string> {
        const supabase = createClient();

        const { data, error } = await supabase
            .from("skills")
            .insert({
                name: request.name,
                description: request.description,
                trigger: request.trigger,
                agent_name: request.agentName,
                steps: request.steps,
                review_status: "pending",
                archived: false,
                created_by: "auto",
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
                updated_at: new Date().toISOString(),
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
                archived: true,
                updated_at: new Date().toISOString(),
            })
            .eq("id", skillId);

        if (error) throw new Error(`SkillCrystallizer.rejectSkill failed: ${error.message}`);
    }

    async recordInvocation(skillId: string, success: boolean): Promise<void> {
        const supabase = createClient();
        const { data, error } = await supabase
            .from("skills")
            .select("times_invoked,times_succeeded")
            .eq("id", skillId)
            .single();

        if (error) throw new Error(`SkillCrystallizer.recordInvocation failed: ${error.message}`);

        const timesInvoked = Number(data?.times_invoked ?? 0) + 1;
        const timesSucceeded = Number(data?.times_succeeded ?? 0) + (success ? 1 : 0);
        const confidence = nextConfidence(timesInvoked, timesSucceeded);

        const { error: updateError } = await supabase
            .from("skills")
            .update({
                times_invoked: timesInvoked,
                times_succeeded: timesSucceeded,
                confidence,
                updated_at: new Date().toISOString(),
            })
            .eq("id", skillId);

        if (updateError) throw new Error(`SkillCrystallizer.recordInvocation update failed: ${updateError.message}`);
    }

    async recordShadowRun(request: ShadowRunRequest): Promise<void> {
        const supabase = createClient();

        const { error } = await supabase
            .from("task_history")
            .insert({
                agent_name: request.agentName,
                task_type: request.taskType,
                input_summary: request.inputSummary,
                output_summary: request.outputSummary,
                status: "shadow",
                skill_id: request.skillId,
                created_at: new Date().toISOString(),
            });

        if (error) throw new Error(`SkillCrystallizer.recordShadowRun failed: ${error.message}`);
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
