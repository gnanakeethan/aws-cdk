import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SpecDatabase } from '@aws-cdk/service-spec-types';
import { TypeScriptRenderer } from '@cdklabs/typewriter';
import type { GenerateModuleMap, GenerateOutput, GenerateOptions as Spec2CdkOptions } from '@aws-cdk/spec2cdk';
import { loadPatchedSpec, util } from '@aws-cdk/spec2cdk';
import type { ModuleMap } from '@aws-cdk/spec2cdk/lib/cfn2ts';
import { MixinAstBuilder } from './ast';
import { MIXINS_PREVIEW_BASE_NAMES } from './config';
import { DEFAULT_FILE_PATTERNS, submoduleFiles } from '@aws-cdk/spec2cdk/lib/cdk/ast';
import { createModuleDefinitionFromCfnNamespace } from '@aws-cdk/spec2cdk/lib/util/pkglint';

type GenerateOptions = Pick<Spec2CdkOptions, 'importLocations' | 'outputPath' | 'clearOutput' | 'debug'>;

export async function generateAll(options: GenerateOptions): Promise<ModuleMap> {
  const db = await loadPatchedSpec();
  const services = await db.all('service');
  const modules: GenerateModuleMap = {};

  for (const service of services) {
    modules[service.name] = {
      services: [{ namespace: service.cloudFormationNamespace }],
    };
  }

  const generated = await generator(db, modules, options);

  const moduleMap: ModuleMap = {};
  Object.entries(generated.modules).map(([moduleName, moduleEntries]) => {
    const definition = createModuleDefinitionFromCfnNamespace(moduleEntries[0]!.service.cloudFormationNamespace, MIXINS_PREVIEW_BASE_NAMES);
    moduleMap[moduleName] = {
      name: definition.moduleName,
      scopes: moduleEntries.map((m) => ({ namespace: m.service.cloudFormationNamespace })),
      resources: moduleEntries.map((m) => m.resources).reduce(mergeObjects, {}),
      files: moduleEntries.flatMap((m) => m.outputFiles),
      definition,
    };
  });

  return moduleMap;
}

export async function generator(
  db: SpecDatabase,
  modules: GenerateModuleMap,
  options: Spec2CdkOptions,
): Promise<GenerateOutput> {
  const timeLabel = '🐢  Completed in';
  util.log.time(timeLabel);
  util.log.debug('Options', options);
  const { clearOutput, outputPath = process.cwd() } = options;

  const renderer = new TypeScriptRenderer();

  // store results in a map of modules
  const moduleMap: GenerateOutput['modules'] = {};

  // Clear output if requested
  if (clearOutput) {
    fs.rmSync(outputPath, {
      force: true,
      recursive: true,
    });
  }

  const ast = new MixinAstBuilder({
    db,
    modulesRoot: options.importLocations?.modulesRoot,
    filePatterns: {
      ...DEFAULT_FILE_PATTERNS,
      resources: 'lib/services/%moduleName%/%serviceShortName%.generated.ts',
    },
  });

  // Go through the module map
  util.log.info('Generating %i modules...', Object.keys(modules).length);
  for (const [moduleName, moduleOptions] of Object.entries(modules)) {
    const services = util.queryDb.getServicesByGenerateServiceRequest(db, moduleOptions.services);

    const serviceModules = services.map(([req, s]) => {
      util.log.debug(moduleName, s.name, 'ast');

      const submod = ast.addService(s, {
        destinationSubmodule: moduleName,
        nameSuffix: req.suffix,
        deprecated: req.deprecated,
        importLocations: moduleOptions.moduleImportLocations ?? options.importLocations,
      });

      return {
        module: submod.resourcesMod.module,
        service: s,
        options: moduleOptions,
        resources: submod.resources,
        outputFiles: submoduleFiles(submod).map((x) => path.resolve(x)),
      };
    });

    if (isNonEmptyList(serviceModules)) {
      moduleMap[moduleName] = serviceModules;
    }
  }

  const writer = new util.TsFileWriter(outputPath, renderer);
  ast.writeAll(writer);

  const result = {
    modules: moduleMap,
    resources: Object.values(moduleMap).flat().map(pick('resources')).reduce(mergeObjects, {}),
    outputFiles: Object.values(moduleMap).flat().flatMap(pick('outputFiles')),
  };

  util.log.info('Summary:');
  util.log.info('  Service files:  %i', Object.values(moduleMap).flat().flatMap(pick('module')).length);
  util.log.info('  Resources:      %i', Object.keys(result.resources).length);
  util.log.timeEnd(timeLabel);

  return result;
}

function pick<T>(property: keyof T) {
  type x = typeof property;
  return (obj: Record<x, any>): any => {
    return obj[property];
  };
}

function mergeObjects<T>(all: T, res: T) {
  return {
    ...all,
    ...res,
  };
}

function isNonEmptyList<T>(arr: T[]): arr is [T, ...T[]] {
  return arr.length > 0;
}
