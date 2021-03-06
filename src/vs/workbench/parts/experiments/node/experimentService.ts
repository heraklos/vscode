/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import product from 'vs/platform/node/product';

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { IStorageService, StorageScope } from 'vs/platform/storage/common/storage';
import { IEnvironmentService } from 'vs/platform/environment/common/environment';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ILifecycleService, LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';

import { IExtensionManagementService, LocalExtensionType } from 'vs/platform/extensionManagement/common/extensionManagement';
import { IRequestService } from 'vs/platform/request/node/request';

import { TPromise } from 'vs/base/common/winjs.base';
import { language } from 'vs/base/common/platform';
import { Disposable, IDisposable, dispose } from 'vs/base/common/lifecycle';
import { match } from 'vs/base/common/glob';
import { asJson } from 'vs/base/node/request';

import { ITextFileService, StateChange } from 'vs/workbench/services/textfile/common/textfiles';
import { WorkspaceStats } from 'vs/workbench/parts/stats/node/workspaceStats';
import { Emitter, Event } from 'vs/base/common/event';


interface IExperimentStorageState {
	enabled: boolean;
	state: ExperimentState;
	editCount?: number;
	lastEditedDate?: string;
}

export enum ExperimentState {
	Evaluating,
	NoRun,
	Run,
	Complete
}

interface IRawExperiment {
	id: string;
	enabled?: boolean;
	condition?: {
		insidersOnly?: boolean;
		displayLanguage?: string;
		installedExtensions?: {
			excludes?: string[];
			includes?: string[];
		},
		fileEdits?: {
			filePathPattern?: string;
			workspaceIncludes?: string[];
			workspaceExcludes?: string[];
			minEditCount: number;
		},
		userProbability?: number;
	};
	action?: { type: string; properties: any };
}

export interface IExperimentActionPromptProperties {
	promptText: string;
	commands: IExperimentActionPromptCommand[];
}

interface IExperimentActionPromptCommand {
	text: string;
	externalLink?: string;
	dontShowAgain?: boolean;
	curatedExtensionsKey?: string;
	curatedExtensionsList?: string[];
}

export interface IExperiment {
	id: string;
	enabled: boolean;
	state: ExperimentState;
	action?: IExperimentAction;
}

export enum ExperimentActionType {
	Custom,
	Prompt,
	AddToRecommendations
}

interface IExperimentAction {
	type: ExperimentActionType;
	properties: any;
}

export interface IExperimentService {
	_serviceBrand: any;
	getExperimentById(id: string): TPromise<IExperiment>;
	getExperimentsToRunByType(type: ExperimentActionType): TPromise<IExperiment[]>;
	getCuratedExtensionsList(curatedExtensionsKey: string): TPromise<string[]>;
	markAsCompleted(experimentId: string): void;

	onExperimentEnabled: Event<IExperiment>;
}

export const IExperimentService = createDecorator<IExperimentService>('experimentService');

export class ExperimentService extends Disposable implements IExperimentService {
	_serviceBrand: any;
	private _experiments: IExperiment[] = [];
	private _loadExperimentsPromise: TPromise<void>;
	private _curatedMapping = Object.create(null);
	private _disposables: IDisposable[] = [];

	private readonly _onExperimentEnabled: Emitter<IExperiment> = new Emitter<IExperiment>();

	onExperimentEnabled: Event<IExperiment> = this._onExperimentEnabled.event;
	constructor(
		@IStorageService private storageService: IStorageService,
		@IExtensionManagementService private extensionManagementService: IExtensionManagementService,
		@ITextFileService private textFileService: ITextFileService,
		@IEnvironmentService private environmentService: IEnvironmentService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@ILifecycleService private lifecycleService: ILifecycleService,
		@IRequestService private requestService: IRequestService
	) {
		super();

		this._loadExperimentsPromise = TPromise.wrap(this.lifecycleService.when(LifecyclePhase.Eventually)).then(() => this.loadExperiments());
	}

	public getExperimentById(id: string): TPromise<IExperiment> {
		return this._loadExperimentsPromise.then(() => {
			return this._experiments.filter(x => x.id === id)[0];
		});
	}

	public getExperimentsToRunByType(type: ExperimentActionType): TPromise<IExperiment[]> {
		return this._loadExperimentsPromise.then(() => {
			if (type === ExperimentActionType.Custom) {
				return this._experiments.filter(x => x.enabled && x.state === ExperimentState.Run && (!x.action || x.action.type === type));
			}
			return this._experiments.filter(x => x.enabled && x.state === ExperimentState.Run && x.action && x.action.type === type);
		});
	}

	public getCuratedExtensionsList(curatedExtensionsKey: string): TPromise<string[]> {
		return this._loadExperimentsPromise.then(() => {
			for (let i = 0; i < this._experiments.length; i++) {
				if (this._experiments[i].enabled
					&& this._experiments[i].state === ExperimentState.Run
					&& this._curatedMapping[this._experiments[i].id]
					&& this._curatedMapping[this._experiments[i].id].curatedExtensionsKey === curatedExtensionsKey) {
					return this._curatedMapping[this._experiments[i].id].curatedExtensionsList;
				}
			}
			return [];
		});
	}

	public markAsCompleted(experimentId: string): void {
		const storageKey = 'experiments.' + experimentId;
		const experimentState: IExperimentStorageState = safeParse(this.storageService.get(storageKey, StorageScope.GLOBAL), {});
		experimentState.state = ExperimentState.Complete;
		this.storageService.store(storageKey, JSON.stringify(experimentState), StorageScope.GLOBAL);
	}

	protected getExperiments(): TPromise<IRawExperiment[]> {
		if (!product.experimentsUrl) {
			return TPromise.as([]);
		}
		return this.requestService.request({ type: 'GET', url: product.experimentsUrl }).then(context => {
			if (context.res.statusCode !== 200) {
				return TPromise.as(null);
			}
			return asJson(context).then(result => {
				return Array.isArray<IRawExperiment>(result['experiments']) ? result['experiments'] : [];
			});
		}, () => TPromise.as(null));
	}

	private loadExperiments(): TPromise<any> {
		return this.getExperiments().then(rawExperiments => {
			// Offline mode
			if (!rawExperiments) {
				const allExperimentIdsFromStorage = safeParse(this.storageService.get('allExperiments', StorageScope.GLOBAL), []);
				if (Array.isArray(allExperimentIdsFromStorage)) {
					allExperimentIdsFromStorage.forEach(experimentId => {
						const storageKey = 'experiments.' + experimentId;
						const experimentState: IExperimentStorageState = safeParse(this.storageService.get(storageKey, StorageScope.GLOBAL), null);
						if (experimentState) {
							this._experiments.push({
								id: experimentId,
								enabled: experimentState.enabled,
								state: experimentState.state
							});
						}
					});
				}
				return TPromise.as(null);
			}

			// Clear disbaled/deleted experiments from storage
			const allExperimentIdsFromStorage = safeParse(this.storageService.get('allExperiments', StorageScope.GLOBAL), []);
			const enabledExperiments = rawExperiments.filter(experiment => !!experiment.enabled).map(experiment => experiment.id.toLowerCase());
			if (Array.isArray(allExperimentIdsFromStorage)) {
				allExperimentIdsFromStorage.forEach(experiment => {
					if (enabledExperiments.indexOf(experiment) === -1) {
						this.storageService.remove('experiments.' + experiment);
					}
				});
			}
			this.storageService.store('allExperiments', JSON.stringify(enabledExperiments), StorageScope.GLOBAL);

			const promises = rawExperiments.map(experiment => {
				const processedExperiment: IExperiment = {
					id: experiment.id,
					enabled: !!experiment.enabled,
					state: !!experiment.enabled ? ExperimentState.Evaluating : ExperimentState.NoRun
				};

				if (experiment.action) {
					processedExperiment.action = {
						type: ExperimentActionType[experiment.action.type] || ExperimentActionType.Custom,
						properties: experiment.action.properties
					};
					if (processedExperiment.action.type === ExperimentActionType.Prompt) {
						((<IExperimentActionPromptProperties>processedExperiment.action.properties).commands || []).forEach(x => {
							if (x.curatedExtensionsKey && Array.isArray(x.curatedExtensionsList)) {
								this._curatedMapping[experiment.id] = x;
							}
						});
					}
				}
				this._experiments.push(processedExperiment);

				if (!processedExperiment.enabled) {
					return TPromise.as(null);
				}

				const storageKey = 'experiments.' + experiment.id;
				const experimentState: IExperimentStorageState = safeParse(this.storageService.get(storageKey, StorageScope.GLOBAL), {});
				if (!experimentState.hasOwnProperty('enabled')) {
					experimentState.enabled = processedExperiment.enabled;
				}
				if (!experimentState.hasOwnProperty('state')) {
					experimentState.state = processedExperiment.enabled ? ExperimentState.Evaluating : ExperimentState.NoRun;
				} else {
					processedExperiment.state = experimentState.state;
				}

				return this.shouldRunExperiment(experiment, processedExperiment).then((state: ExperimentState) => {
					experimentState.state = processedExperiment.state = state;
					this.storageService.store(storageKey, JSON.stringify(experimentState));

					if (state === ExperimentState.Run) {
						this._onExperimentEnabled.fire(processedExperiment);
					}
					return TPromise.as(null);
				});

			});
			return TPromise.join(promises).then(() => {
				this.telemetryService.publicLog('experiments', this._experiments);
			});
		});
	}

	private shouldRunExperiment(experiment: IRawExperiment, processedExperiment: IExperiment): TPromise<ExperimentState> {
		if (processedExperiment.state !== ExperimentState.Evaluating) {
			return TPromise.wrap(processedExperiment.state);
		}

		if (!experiment.enabled) {
			return TPromise.wrap(ExperimentState.NoRun);
		}

		if (!experiment.condition) {
			return TPromise.wrap(ExperimentState.Run);
		}

		if (this.environmentService.appQuality === 'stable' && experiment.condition.insidersOnly === true) {
			return TPromise.wrap(ExperimentState.NoRun);
		}

		if (typeof experiment.condition.displayLanguage === 'string') {
			let localeToCheck = experiment.condition.displayLanguage.toLowerCase();
			let displayLanguage = language.toLowerCase();

			if (localeToCheck !== displayLanguage) {
				const a = displayLanguage.indexOf('-');
				const b = localeToCheck.indexOf('-');
				if (a > -1) {
					displayLanguage = displayLanguage.substr(0, a);
				}
				if (b > -1) {
					localeToCheck = localeToCheck.substr(0, b);
				}
				if (displayLanguage !== localeToCheck) {
					return TPromise.wrap(ExperimentState.NoRun);
				}
			}
		}

		if (!experiment.condition.userProbability) {
			experiment.condition.userProbability = 1;
		}

		let extensionsCheckPromise = TPromise.as(true);
		if (experiment.condition.installedExtensions) {
			extensionsCheckPromise = this.extensionManagementService.getInstalled(LocalExtensionType.User).then(locals => {
				let includesCheck = true;
				let excludesCheck = true;
				const localExtensions = locals.map(local => `${local.manifest.publisher.toLowerCase()}.${local.manifest.name.toLowerCase()}`);
				if (Array.isArray(experiment.condition.installedExtensions.includes) && experiment.condition.installedExtensions.includes.length) {
					const extensionIncludes = experiment.condition.installedExtensions.includes.map(e => e.toLowerCase());
					includesCheck = localExtensions.some(e => extensionIncludes.indexOf(e) > -1);
				}
				if (Array.isArray(experiment.condition.installedExtensions.excludes) && experiment.condition.installedExtensions.excludes.length) {
					const extensionExcludes = experiment.condition.installedExtensions.excludes.map(e => e.toLowerCase());
					excludesCheck = !localExtensions.some(e => extensionExcludes.indexOf(e) > -1);
				}
				return includesCheck && excludesCheck;
			});
		}

		const storageKey = 'experiments.' + experiment.id;
		const experimentState: IExperimentStorageState = safeParse(this.storageService.get(storageKey, StorageScope.GLOBAL), {});

		return extensionsCheckPromise.then(success => {
			if (!success || !experiment.condition.fileEdits || typeof experiment.condition.fileEdits.minEditCount !== 'number') {
				const runExperiment = success && Math.random() < experiment.condition.userProbability;
				return runExperiment ? ExperimentState.Run : ExperimentState.NoRun;
			}

			experimentState.editCount = experimentState.editCount || 0;
			if (experimentState.editCount >= experiment.condition.fileEdits.minEditCount) {
				return ExperimentState.Run;
			}

			const onSaveHandler = this.textFileService.models.onModelsSaved(e => {
				const date = new Date().toDateString();
				const latestExperimentState: IExperimentStorageState = safeParse(this.storageService.get(storageKey, StorageScope.GLOBAL), {});
				if (latestExperimentState.state !== ExperimentState.Evaluating) {
					onSaveHandler.dispose();
					return;
				}
				e.forEach(event => {
					if (event.kind !== StateChange.SAVED
						|| latestExperimentState.state !== ExperimentState.Evaluating
						|| date === latestExperimentState.lastEditedDate
						|| latestExperimentState.editCount >= experiment.condition.fileEdits.minEditCount) {
						return;
					}
					let filePathCheck = true;
					let workspaceCheck = true;

					if (typeof experiment.condition.fileEdits.filePathPattern === 'string') {
						filePathCheck = match(experiment.condition.fileEdits.filePathPattern, event.resource.fsPath);
					}
					if (Array.isArray(experiment.condition.fileEdits.workspaceIncludes) && experiment.condition.fileEdits.workspaceIncludes.length) {
						workspaceCheck = experiment.condition.fileEdits.workspaceIncludes.some(x => !!WorkspaceStats.tags[x]);
					}
					if (workspaceCheck && Array.isArray(experiment.condition.fileEdits.workspaceExcludes) && experiment.condition.fileEdits.workspaceExcludes.length) {
						workspaceCheck = !experiment.condition.fileEdits.workspaceExcludes.some(x => !!WorkspaceStats.tags[x]);
					}
					if (filePathCheck && workspaceCheck) {
						latestExperimentState.editCount = (latestExperimentState.editCount || 0) + 1;
						latestExperimentState.lastEditedDate = date;
						this.storageService.store(storageKey, JSON.stringify(latestExperimentState), StorageScope.GLOBAL);
					}
				});
				if (latestExperimentState.editCount >= experiment.condition.fileEdits.minEditCount) {
					processedExperiment.state = latestExperimentState.state = Math.random() < experiment.condition.userProbability ? ExperimentState.Run : ExperimentState.NoRun;
					this.storageService.store(storageKey, JSON.stringify(latestExperimentState), StorageScope.GLOBAL);
					if (latestExperimentState.state === ExperimentState.Run && ExperimentActionType[experiment.action.type] === ExperimentActionType.Prompt) {
						this._onExperimentEnabled.fire(processedExperiment);
					}
				}
			});
			this._disposables.push(onSaveHandler);
			return ExperimentState.Evaluating;
		});
	}

	dispose() {
		this._disposables = dispose(this._disposables);
	}
}


function safeParse(text: string, defaultObject: any) {
	try {
		return JSON.parse(text) || defaultObject;
	}
	catch (e) {
		return defaultObject;
	}
}