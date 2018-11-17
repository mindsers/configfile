import { InjectionToken } from 'yabf'

import { LOG_LEVEL } from '../services'

export const OPTION_PATH_FILE_TOKEN = new InjectionToken()

export const APP_LOG_LEVEL_TOKEN = new InjectionToken()
export const APP_LOG_LEVEL = LOG_LEVEL.ERROR
