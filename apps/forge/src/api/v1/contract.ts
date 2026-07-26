import { oc } from "@orpc/contract"

import { publicApiErrors } from "@/api/v1/errors"
import { teamsContract } from "@/api/v1/teams/contract"

export const publicApiContract = oc.errors(publicApiErrors).router({
  teams: teamsContract,
})
