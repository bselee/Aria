import { createClient } from '@/lib/supabase';

export interface SkillStep {
  order: number;
  action: 'tool_call' | 'llm_call' | 'db_query' | 'api_call' | 'wait' | 'decision';
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
  name: string;
  description: string;
  trigger: string;
  agent_name: string;
  steps: SkillStep[];
  confidence: number;
  times_invoked: number;
  times_succeeded: number;
  created_at: string;
  updated_at: string;
  created_by: 'auto' | 'manual';
  review_status: 'pending' | 'approved' | 'rejected';
  rejection_feedback?: string;
  archived: boolean;
}

export class SkillCrystallizer {
  async crystallize(request: CrystallizeRequest): Promise<string> {
    const supabase = createClient();
    
    const { data, error } = await supabase
      .from('skills')
      .insert({
        name: `${request.agentName}: ${request.taskType}`,
        description: `Input: ${request.inputSummary} → Output: ${request.outputSummary}`,
        trigger: `${request.taskType} ${request.inputSummary}`.toLowerCase(),
        agent_name: request.agentName,
        steps: request.executionTrace,
        review_status: 'pending',
        created_by: 'auto',
      })
      .select('id')
      .single();

    if (error) throw new Error(`Failed to crystallize skill: ${error.message}`);
    return data.id;
  }

  async getPendingSkills(): Promise<Skill[]> {
    const supabase = createClient();
    
    const { data, error } = await supabase
      .from('skills')
      .select('*')
      .eq('review_status', 'pending')
      .eq('archived', false)
      .order('created_at', { ascending: false });

    if (error) throw new Error(`Failed to get pending skills: ${error.message}`);
    return data || [];
  }

  async approveSkill(skillId: string): Promise<void> {
    const supabase = createClient();
    
    const { error } = await supabase
      .from('skills')
      .update({ 
        review_status: 'approved',
        updated_at: new Date().toISOString(),
      })
      .eq('id', skillId);

    if (error) throw new Error(`Failed to approve skill: ${error.message}`);
  }

  async rejectSkill(skillId: string, feedback: string): Promise<void> {
    const supabase = createClient();
    
    const { error } = await supabase
      .from('skills')
      .update({ 
        review_status: 'rejected',
        rejection_feedback: feedback,
        updated_at: new Date().toISOString(),
      })
      .eq('id', skillId);

    if (error) throw new Error(`Failed to reject skill: ${error.message}`);
  }

  async findMatchingSkill(trigger: string): Promise<Skill | null> {
    const supabase = createClient();
    const triggerWords = trigger.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    
    if (triggerWords.length === 0) return null;

    const { data, error } = await supabase
      .from('skills')
      .select('*')
      .eq('review_status', 'approved')
      .eq('archived', false)
      .order('confidence', { ascending: false })
      .limit(10);

    if (error) throw new Error(`Failed to find matching skill: ${error.message}`);
    if (!data || data.length === 0) return null;

    let bestMatch: Skill | null = null;
    let bestScore = 0;

    for (const skill of data) {
      const skillWords = skill.trigger.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const matchedWords = triggerWords.filter(tw => skillWords.some(sw => sw.includes(tw) || tw.includes(sw)));
      const score = matchedWords.length / Math.max(triggerWords.length, skillWords.length);
      
      if (score > bestScore && score > 0.3) {
        bestScore = score;
        bestMatch = skill;
      }
    }

    return bestMatch;
  }
}
