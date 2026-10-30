import { z } from "zod"

export const personalSkillSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().trim().min(1, "Enter a skill name.").max(120),
    instructions: z
      .string()
      .trim()
      .min(1, "Add instructions for this skill.")
      .max(50000),
    createdAt: z.string().datetime(),
    revision: z.number().int().nonnegative(),
  })
  .strict()
export const personalizationSchema = z.object({
  guidance: z.string().max(50000),
  skills: z.array(personalSkillSchema),
})
export type PersonalSkill = z.infer<typeof personalSkillSchema>
export type AgentPersonalization = z.infer<typeof personalizationSchema>
export const personalizationStorageKey = (userId: string) =>
  `forge:agent-personalization:v1:${userId}`
