import test from 'ava'

test.todo('FileService#scripts should return name and path of valid script')
test.todo('FileService#modules should return name and path of valid modules')
test.todo('FileService#modules should return target and source of each file in modules')
test.todo('FileService#runScript should call chmod')
test.todo('FileService#runScript should call execFile')
test.todo(`FileService#runScript should rethrows BadScriptPermission when 'EACCESS' error is thrown`)
