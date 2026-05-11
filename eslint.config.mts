import tseslint from 'typescript-eslint';
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { globalIgnores } from "eslint/config";

/**
 * ESLint config — strict on new code, lenient on legacy code that pre-dates the
 * 2.0 rebuild. The legacy files use dynamic shape (regex-parsed span markup)
 * which the eslint-plugin-obsidianmd type-safety rules can't reason about
 * without a wholesale rewrite that's out of scope for this release.
 */
export default tseslint.config(
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: [
						'eslint.config.js',
						'manifest.json'
					]
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json']
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Relax rules that conflict with established product vocabulary
		// (e.g. "API key", "OnlyWorlds" — case is intentional)
		rules: {
			"obsidianmd/ui/sentence-case": "off",
			"no-console": "off",
		},
	},
	globalIgnores([
		"node_modules",
		"dist",
		"esbuild.config.mjs",
		"eslint.config.mts",
		"version-bump.mjs",
		"versions.json",
		"main.js",
		// Legacy v1 span-tag pipeline — dynamic shapes, pre-2.0 code.
		// Not refactoring as part of this release; see plugin redesign doc.
		"Commands/CopyWorldCommand.ts",
		"Commands/CreateCategoryFoldersCommand.ts",
		"Commands/CreateCoreFilesCommand.ts",
		"Commands/CreateElementCommand.ts",
		"Commands/CreateHandlebarsCommand.ts",
		"Commands/CreateReadmeCommand.ts",
		"Commands/CreateSettingsCommand.ts",
		"Commands/CreateTemplatesCommand.ts",
		"Commands/CreateWorldCommand.ts",
		"Commands/ImportWorldCommand.ts",
		"Commands/PasteWorldCommand.ts",
		"Commands/RenameWorldCommand.ts",
		"Commands/UpdateCategoryCountsCommand.ts",
		"Commands/ValidateWorldCommand.ts",
		"Listeners/NoteLinker.ts",
		"Listeners/NameChanger.ts",
		"Modals/ApiResponseModal.ts",
		"Modals/CreateElementFromLinkModal.ts",
		"Modals/CreateElementModal.ts",
		"Modals/CreateWorldModal.ts",
		"Modals/ElementSelectionModal.ts",
		"Modals/NameInputModal.ts",
		"Modals/PinInputModal.ts",
		"Modals/TemplateSelectionModal.ts",
		"Modals/ValidateCopyResultModal.ts",
		"Modals/ValidateExportResultModal.ts",
		"Modals/ValidateResultModal.ts",
		"Modals/WorldCopyModal.ts",
		"Modals/WorldImportModal.ts",
		"Modals/WorldKeyModal.ts",
		"Modals/WorldKeySelectionModal.ts",
		"Modals/WorldNameModal.ts",
		"Modals/WorldPasteModal.ts",
		"Modals/WorldPinSelectionModal.ts",
		"Modals/WorldRenameModal.ts",
		"Modals/WorldSelectionModal.ts",
		"Scripts/WorldService.ts",
		"Scripts/WorldDataTemplate.ts",
	]),
);
