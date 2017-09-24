# configfile

[![npm](https://img.shields.io/npm/v/configfile.svg?style=flat-square)]()
[![npm](https://img.shields.io/npm/dw/configfile.svg?style=flat-square)]()
[![npm](https://img.shields.io/npm/l/configfile.svg?style=flat-square)]()

**configfile** is a command line tool that help user to manage their own configuration files.

## Data storage

This tool does not store configuration files for you. A git repo is needed to store your configuration files.

Please follow this structure:

```txt
/files/
    /module1/
    /module2/
        /settings.json
        /configurationfile.txt
    /module3/
/scripts/
    /scriptfile.sh
```

## Usage

### Initialization / configuration

`configfile init` Initialize *configfile* on the current user session.

### Deploy configuration files

`configfile deploy [moduleName...]` Deploy the configuration files for the given module name.

### Run script

`configfile run <scriptName>` Execute the script identifying by the given script name.

## License

This project is under Apache-2.0 license. See LICENSE file.
