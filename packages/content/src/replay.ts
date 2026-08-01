import { compileContentPack, versionedKey } from "./compile";
import { ContentValidationError } from "./errors";
import { canonicalContentJson } from "./hash";
import type { VersionedEntity, VersionedRef } from "./model";

function refKey(ref: VersionedRef): string {
  return `${ref.id}@${ref.version}`;
}

function required<T extends VersionedEntity>(rows: readonly T[], ref: VersionedRef, path: string): T {
  const row = rows.find((candidate) => refKey(candidate) === refKey(ref));
  if (!row) throw new ContentValidationError([{ code: "BROKEN_REFERENCE", path, message: `Unknown pinned reference ${refKey(ref)}.` }]);
  return row;
}

export function recipeSnapshot(input: unknown, recipeRef: VersionedRef): string {
  const bundle = compileContentPack(input).bundle;
  const recipe = required(bundle.recipes, recipeRef, "$.recipeRef");
  const dish = required(bundle.dishes, recipe.dishRef, "$.recipe.dishRef");
  const art = new Map(bundle.artAssets.map((asset) => [asset.key, asset]));
  return canonicalContentJson({
    schemaVersion: bundle.schemaVersion,
    recipe,
    dish,
    dishArt: art.get(dish.artKey),
    family: required(bundle.families, dish.familyRef, "$.dish.familyRef"),
    components: recipe.exactComponentAmounts.map((amount) => {
      const component = required(bundle.components, amount.componentRef, "$.recipe.exactComponentAmounts.componentRef");
      const ingredient = required(bundle.ingredients, component.ingredientRef, "$.component.ingredientRef");
      return {
        amount,
        component,
        componentArt: art.get(component.artKey),
        ingredient,
        ingredientArt: art.get(ingredient.artKey),
        cutStyle: component.cutStyleRef ? required(bundle.cutStyles, component.cutStyleRef, "$.component.cutStyleRef") : null,
      };
    }),
    seasonalityRules: recipe.seasonalityRuleRefs.map((ref) => required(bundle.seasonalityRules, ref, "$.recipe.seasonalityRuleRefs")),
    identity: versionedKey("recipe", recipe),
  });
}
