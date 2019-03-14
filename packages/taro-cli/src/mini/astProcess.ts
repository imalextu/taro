import * as fs from 'fs-extra'
import * as path from 'path'

import * as babel from 'babel-core'
import * as t from 'babel-types'
import generate from 'babel-generator'
import traverse from 'babel-traverse'
import _ from 'lodash'
import { Config as IConfig } from '@tarojs/taro'

const template = require('babel-template')

import {
  REG_SCRIPT,
  REG_TYPESCRIPT,
  REG_JSON,
  REG_FONT,
  REG_IMAGE,
  REG_MEDIA,
  REG_STYLE,
  CSS_EXT,
  processTypeEnum,
  BUILD_TYPES,
  NODE_MODULES_REG,
  PARSE_AST_TYPE,
  taroJsComponents,
  taroJsRedux,
  taroJsFramework,
  DEVICE_RATIO_NAME,
  taroJsQuickAppComponents
} from '../util/constants'
import {
  resolveScriptPath,
  printLog,
  promoteRelativePath,
  isNpmPkg,
  isAliasPath,
  replaceAliasPath,
  traverseObjectNode,
  isQuickAppPkg
} from '../util'
import { convertObjectToAstExpression, convertArrayToAstExpression } from '../util/astConvert'
import babylonConfig from '../config/babylon'
import { getExactedNpmFilePath, getNotExistNpmList } from '../util/npmExact'

import { IComponentObj } from './interface'
import {
  getBuildData,
  isFileToBePage
} from './helper'
import { processStyleUseCssModule } from './compileStyle'

interface IAnalyzeImportUrlOptions {
  astPath: any,
  value: string,
  sourceFilePath: string,
  filePath: string,
  styleFiles: string[],
  scriptFiles: string[],
  jsonFiles: string[],
  mediaFiles: string[]
}

function analyzeImportUrl ({
  astPath,
  value,
  sourceFilePath,
  filePath,
  styleFiles,
  scriptFiles,
  jsonFiles,
  mediaFiles
}: IAnalyzeImportUrlOptions): void {
  const valueExtname = path.extname(value)
  const node = astPath.node
  const {
    nodeModulesPath,
    npmOutputDir,
    sourceDir,
    outputDir
  } = getBuildData()
  if (value.indexOf('.') === 0) {
    let importPath = path.resolve(path.dirname(sourceFilePath), value)
    importPath = resolveScriptPath(importPath)
    if (isFileToBePage(importPath)) {
      astPath.remove()
    } else {
      if (REG_SCRIPT.test(valueExtname) || REG_TYPESCRIPT.test(valueExtname)) {
        const vpath = path.resolve(sourceFilePath, '..', value)
        let fPath = value
        if (fs.existsSync(vpath) && vpath !== sourceFilePath) {
          fPath = vpath
        }
        if (scriptFiles.indexOf(fPath) < 0) {
          scriptFiles.push(fPath)
        }
      } else if (REG_JSON.test(valueExtname)) {
        const vpath = path.resolve(sourceFilePath, '..', value)
        if (jsonFiles.indexOf(vpath) < 0) {
          jsonFiles.push(vpath)
        }
        if (fs.existsSync(vpath)) {
          const obj = JSON.parse(fs.readFileSync(vpath).toString())
          const specifiers = node.specifiers
          let defaultSpecifier = null
          specifiers.forEach(item => {
            if (item.type === 'ImportDefaultSpecifier') {
              defaultSpecifier = item.local.name
            }
          })
          if (defaultSpecifier) {
            let objArr: t.NullLiteral | t.Expression = t.nullLiteral()
            if (Array.isArray(obj)) {
              objArr = t.arrayExpression(convertArrayToAstExpression(obj))
            } else {
              objArr = t.objectExpression(convertObjectToAstExpression(obj))
            }
            astPath.replaceWith(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(defaultSpecifier), objArr)]))
          }
        }
      } else if (REG_FONT.test(valueExtname) || REG_IMAGE.test(valueExtname) || REG_MEDIA.test(valueExtname)) {
        const vpath = path.resolve(sourceFilePath, '..', value)
        if (!fs.existsSync(vpath)) {
          printLog(processTypeEnum.ERROR, '引用文件', `文件 ${sourceFilePath} 中引用 ${value} 不存在！`)
          return
        }
        if (mediaFiles.indexOf(vpath) < 0) {
          mediaFiles.push(vpath)
        }
        const specifiers = node.specifiers
        let defaultSpecifier = null
        specifiers.forEach(item => {
          if (item.type === 'ImportDefaultSpecifier') {
            defaultSpecifier = item.local.name
          }
        })
        let sourceDirPath = sourceDir
        if (NODE_MODULES_REG.test(vpath)) {
          sourceDirPath = nodeModulesPath
        }

        if (defaultSpecifier) {
          astPath.replaceWith(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(defaultSpecifier), t.stringLiteral(vpath.replace(sourceDirPath, '').replace(/\\/g, '/')))]))
        } else {
          astPath.remove()
        }
      } else if (REG_STYLE.test(valueExtname)) {
        const stylePath = path.resolve(path.dirname(sourceFilePath), value)
        if (styleFiles.indexOf(stylePath) < 0) {
          styleFiles.push(stylePath)
        }
        astPath.remove()
      } else {
        let vpath = resolveScriptPath(path.resolve(sourceFilePath, '..', value))
        let outputVpath
        if (NODE_MODULES_REG.test(vpath)) {
          outputVpath = vpath.replace(nodeModulesPath, npmOutputDir)
        } else {
          outputVpath = vpath.replace(sourceDir, outputDir)
        }
        let relativePath = path.relative(filePath, outputVpath)
        if (vpath && vpath !== sourceFilePath) {
          if (!fs.existsSync(vpath)) {
            printLog(processTypeEnum.ERROR, '引用文件', `文件 ${sourceFilePath} 中引用 ${value} 不存在！`)
          } else {
            if (fs.lstatSync(vpath).isDirectory()) {
              if (fs.existsSync(path.join(vpath, 'index.js'))) {
                vpath = path.join(vpath, 'index.js')
                relativePath = path.join(relativePath, 'index.js')
              } else {
                printLog(processTypeEnum.ERROR, '引用目录', `文件 ${sourceFilePath} 中引用了目录 ${value}！`)
                return
              }
            }
            if (scriptFiles.indexOf(vpath) < 0) {
              scriptFiles.push(vpath)
            }
            relativePath = promoteRelativePath(relativePath)
            relativePath = relativePath.replace(path.extname(relativePath), '.js')
            node.source.value = relativePath
          }
        }
      }
    }
  }
}

export interface IParseAstReturn {
  code: string,
  styleFiles: string[],
  scriptFiles: string[],
  jsonFiles: string[],
  mediaFiles: string[]
  configObj: IConfig,
  componentClassName: string
}

export function parseAst (
  type: PARSE_AST_TYPE,
  ast: t.File,
  depComponents: IComponentObj[],
  sourceFilePath: string,
  filePath: string,
  npmSkip: boolean = false
): IParseAstReturn {
  const styleFiles: string[] = []
  const scriptFiles: string[] = []
  const jsonFiles: string[] = []
  const mediaFiles: string[] = []

  const {
    nodeModulesPath,
    npmOutputDir,
    sourceDir,
    outputDir,
    buildAdapter,
    constantsReplaceList,
    isProduction,
    npmConfig,
    alias: pathAlias,
    compileInclude,
    projectConfig
  } = getBuildData()
  const notExistNpmList = getNotExistNpmList()
  const taroMiniAppFramework = `@tarojs/taro-${buildAdapter}`
  let configObj: IConfig = {}
  let componentClassName: string = ''
  let taroJsReduxConnect: string = ''
  let taroImportDefaultName
  let needExportDefault = false
  let exportTaroReduxConnected: string | null = null
  const isQuickApp = buildAdapter === BUILD_TYPES.QUICKAPP
  const cannotRemoves = [taroJsFramework, 'react', 'nervjs']
  if (isQuickApp) {
    cannotRemoves.push(taroJsComponents)
  }
  ast = babel.transformFromAst(ast, '', {
    plugins: [
      [require('babel-plugin-danger-remove-unused-import'), { ignore: cannotRemoves }],
      [require('babel-plugin-transform-define').default, constantsReplaceList]
    ]
  }).ast as t.File
  traverse(ast, {
    ClassDeclaration (astPath) {
      const node = astPath.node
      let hasCreateData = false
      if (node.superClass) {
        astPath.traverse({
          ClassMethod (astPath) {
            if (astPath.get('key').isIdentifier({ name: '_createData' })) {
              hasCreateData = true
            }
          }
        })
        if (hasCreateData) {
          needExportDefault = true
          astPath.traverse({
            ClassMethod (astPath) {
              const node = astPath.node
              if (node.kind === 'constructor') {
                astPath.traverse({
                  ExpressionStatement (astPath) {
                    const node = astPath.node
                    if (node.expression &&
                      node.expression.type === 'AssignmentExpression' &&
                      node.expression.operator === '=') {
                      const left = node.expression.left
                      if (left.type === 'MemberExpression' &&
                        left.object.type === 'ThisExpression' &&
                        left.property.type === 'Identifier' &&
                        left.property.name === 'config') {
                        configObj = traverseObjectNode(node.expression.right, buildAdapter)
                      }
                    }
                  }
                })
              }
            }
          })
          if (node.id === null) {
            componentClassName = '_TaroComponentClass'
            astPath.replaceWith(
              t.classDeclaration(
                t.identifier(componentClassName),
                node.superClass as t.Expression,
                node.body as t.ClassBody,
                node.decorators as t.Decorator[] || []
              )
            )
          } else if (node.id.name === 'App') {
            componentClassName = '_App'
            astPath.replaceWith(
              t.classDeclaration(
                t.identifier(componentClassName),
                node.superClass as t.Expression,
                node.body as t.ClassBody,
                node.decorators as t.Decorator[] || []
              )
            )
          } else {
            componentClassName = node.id.name
          }
        }
      }
    },

    ClassExpression (astPath) {
      const node = astPath.node
      if (node.superClass) {
        let hasCreateData = false
        astPath.traverse({
          ClassMethod (astPath) {
            if (astPath.get('key').isIdentifier({ name: '_createData' })) {
              hasCreateData = true
            }
          }
        })
        if (hasCreateData) {
          needExportDefault = true
          if (node.id === null) {
            const parentNode = astPath.parentPath.node as any
            if (t.isVariableDeclarator(astPath.parentPath)) {
              componentClassName = parentNode.id.name
            } else {
              componentClassName = '_TaroComponentClass'
            }
            astPath.replaceWith(
              t.classExpression(
                t.identifier(componentClassName),
                node.superClass as t.Expression,
                node.body as t.ClassBody,
                node.decorators as t.Decorator[] || []
              )
            )
          } else if (node.id.name === 'App') {
            componentClassName = '_App'
            astPath.replaceWith(
              t.classExpression(
                t.identifier(componentClassName),
                node.superClass as t.Expression,
                node.body as t.ClassBody,
                node.decorators as t.Decorator[] || []
              )
            )
          } else {
            componentClassName = node.id.name
          }
        }
      }
    },

    ClassProperty (astPath) {
      const node = astPath.node
      if (node.key.name === 'config') {
        configObj = traverseObjectNode(node, buildAdapter)
      }
    },

    ImportDeclaration (astPath) {
      const node = astPath.node
      const source = node.source
      let value = source.value
      const specifiers = node.specifiers
      // alias 替换
      if (isAliasPath(value, pathAlias)) {
        value = replaceAliasPath(sourceFilePath, value, pathAlias)
        source.value = value
      }
      if (isNpmPkg(value) && !isQuickAppPkg(value) && !notExistNpmList.has(value)) {
        if (value === taroJsComponents) {
          if (isQuickApp) {
            console.log(specifiers)
          }
          astPath.remove()
        } else {
          let isDepComponent = false
          if (depComponents && depComponents.length) {
            depComponents.forEach(item => {
              if (item.path === value) {
                isDepComponent = true
              }
            })
          }
          if (isDepComponent) {
            astPath.remove()
          } else {
            const specifiers = node.specifiers
            if (value === taroJsFramework) {
              let defaultSpecifier: string | null = null
              specifiers.forEach(item => {
                if (item.type === 'ImportDefaultSpecifier') {
                  defaultSpecifier = item.local.name
                }
              })
              if (defaultSpecifier) {
                taroImportDefaultName = defaultSpecifier
              }
              value = taroMiniAppFramework
            } else if (value === taroJsRedux) {
              specifiers.forEach(item => {
                if (item.type === 'ImportSpecifier') {
                  const local = item.local
                  if (local.type === 'Identifier' && local.name === 'connect') {
                    taroJsReduxConnect = item.imported.name
                  }
                }
              })
            }
            if (!npmSkip) {
              source.value = getExactedNpmFilePath({
                npmName: value,
                filePath,
                isProduction,
                npmConfig,
                buildAdapter,
                npmOutputDir,
                compileInclude
              })
            } else {
              source.value = value
            }
          }
        }
      } else if (CSS_EXT.indexOf(path.extname(value)) !== -1 && specifiers.length > 0) { // 对 使用 import style from './style.css' 语法引入的做转化处理
        printLog(processTypeEnum.GENERATE, '替换代码', `为文件 ${sourceFilePath} 生成 css modules`)
        const styleFilePath = path.join(path.dirname(sourceFilePath), value)
        const styleCode = fs.readFileSync(styleFilePath).toString()
        const result = processStyleUseCssModule({
          css: styleCode,
          filePath: styleFilePath
        })
        const tokens = result.root.exports || {}
        const objectPropperties: t.ObjectProperty[] = []
        for (const key in tokens) {
          if (tokens.hasOwnProperty(key)) {
            objectPropperties.push(t.objectProperty(t.identifier(key), t.stringLiteral(tokens[key])))
          }
        }
        let defaultDeclator: t.VariableDeclarator[] | null = null
        let normalDeclator: t.VariableDeclarator[] | null = null
        const importItems: any[] = []
        specifiers.forEach(s => {
          if (t.isImportDefaultSpecifier(s)) {
            defaultDeclator = [t.variableDeclarator(t.identifier(s.local.name), t.objectExpression(objectPropperties))]
          } else {
            importItems.push(t.objectProperty(t.identifier(s.local.name), t.identifier(s.local.name)))
          }
        })
        normalDeclator = [t.variableDeclarator(t.objectPattern(importItems), t.objectExpression(objectPropperties))]
        if (defaultDeclator) {
          astPath.insertBefore(t.variableDeclaration('const', defaultDeclator))
        }
        if (normalDeclator) {
          astPath.insertBefore(t.variableDeclaration('const', normalDeclator))
        }
        astPath.remove()
        if (styleFiles.indexOf(styleFilePath) < 0) { // add this css file to queue
          styleFiles.push(styleFilePath)
        }
      } else if (path.isAbsolute(value)) {
        printLog(processTypeEnum.ERROR, '引用文件', `文件 ${sourceFilePath} 中引用 ${value} 是绝对路径！`)
      }
    },

    CallExpression (astPath) {
      const node = astPath.node
      const callee = node.callee as (t.Identifier | t.MemberExpression)
      if (t.isMemberExpression(callee)) {
        if (taroImportDefaultName && (callee.object as t.Identifier).name === taroImportDefaultName && (callee.property as t.Identifier).name === 'render') {
          astPath.remove()
        }
      } else if (callee.name === 'require') {
        const args = node.arguments as t.StringLiteral[]
        let value = args[0].value
        if (isAliasPath(value, pathAlias)) {
          value = replaceAliasPath(sourceFilePath, value, pathAlias)
          args[0].value = value
        }
        if (isNpmPkg(value) && !isQuickAppPkg(value) && !notExistNpmList.has(value)) {
          if (value === taroJsComponents) {
            if (buildAdapter === BUILD_TYPES.QUICKAPP) {
              args[0].value = taroJsQuickAppComponents
              value = taroJsQuickAppComponents
            } else {
              astPath.remove()
            }
          } else {
            let isDepComponent = false
            if (depComponents && depComponents.length) {
              depComponents.forEach(item => {
                if (item.path === value) {
                  isDepComponent = true
                }
              })
            }
            if (isDepComponent) {
              astPath.remove()
            } else {
              if (t.isVariableDeclaration(astPath.parentPath.parentPath)) {
                const parentNode = astPath.parentPath.parentPath.node as t.VariableDeclaration
                if (parentNode.declarations.length === 1 && parentNode.declarations[0].init) {
                  const id = parentNode.declarations[0].id
                  if (value === taroJsFramework && id.type === 'Identifier') {
                    taroImportDefaultName = id.name
                    value = taroMiniAppFramework
                  } else if (value === taroJsRedux) {
                    const declarations = parentNode.declarations
                    declarations.forEach(item => {
                      const id = item.id
                      if (id.type === 'ObjectPattern') {
                        const properties = id.properties as any
                        properties.forEach(p => {
                          if (p.type === 'ObjectProperty') {
                            if (p.value.type === 'Identifier' && p.value.name === 'connect') {
                              taroJsReduxConnect = p.key.name
                            }
                          }
                        })
                      }
                    })
                  }
                }
              }
              if (!npmSkip) {
                args[0].value = getExactedNpmFilePath({
                  npmName: value,
                  filePath,
                  isProduction,
                  npmConfig,
                  buildAdapter,
                  npmOutputDir,
                  compileInclude
                })
              } else {
                args[0].value = value
              }
            }
          }
        } else if (CSS_EXT.indexOf(path.extname(value)) !== -1 && t.isVariableDeclarator(astPath.parentPath)) { // 对 使用 const style = require('./style.css') 语法引入的做转化处理
          printLog(processTypeEnum.GENERATE, '替换代码', `为文件 ${sourceFilePath} 生成 css modules`)
          const styleFilePath = path.join(path.dirname(sourceFilePath), value)
          const styleCode = fs.readFileSync(styleFilePath).toString()
          const result = processStyleUseCssModule({
            css: styleCode,
            filePath: styleFilePath
          })
          const tokens = result.root.exports || {}
          const objectPropperties: t.ObjectProperty[] = []
          for (const key in tokens) {
            if (tokens.hasOwnProperty(key)) {
              objectPropperties.push(t.objectProperty(t.identifier(key), t.stringLiteral(tokens[key])))
            }
          }
          astPath.replaceWith(t.objectExpression(objectPropperties))
          if (styleFiles.indexOf(styleFilePath) < 0) { // add this css file to queue
            styleFiles.push(styleFilePath)
          }
        } else if (path.isAbsolute(value)) {
          printLog(processTypeEnum.ERROR, '引用文件', `文件 ${sourceFilePath} 中引用 ${value} 是绝对路径！`)
        }
      }
    },

    ExportDefaultDeclaration (astPath) {
      const node = astPath.node
      const declaration = node.declaration
      needExportDefault = false
      if (
        declaration &&
        (declaration.type === 'ClassDeclaration' || declaration.type === 'ClassExpression')
      ) {
        const superClass = declaration.superClass
        if (superClass) {
          let hasCreateData = false
          astPath.traverse({
            ClassMethod (astPath) {
              if (astPath.get('key').isIdentifier({ name: '_createData' })) {
                hasCreateData = true
              }
            }
          })
          if (hasCreateData) {
            needExportDefault = true
            if (declaration.id === null) {
              componentClassName = '_TaroComponentClass'
            } else if (declaration.id.name === 'App') {
              componentClassName = '_App'
            } else {
              componentClassName = declaration.id.name
            }
            const isClassDcl = declaration.type === 'ClassDeclaration'
            const classDclProps = [t.identifier(componentClassName), superClass, declaration.body, declaration.decorators || []]
            astPath.replaceWith(isClassDcl ? t.classDeclaration.apply(null, classDclProps) : t.classExpression.apply(null, classDclProps))
          }
        }
      } else if (declaration.type === 'CallExpression') {
        const callee = declaration.callee
        if (callee && callee.type === 'CallExpression') {
          const subCallee = callee.callee
          if (subCallee.type === 'Identifier' && subCallee.name === taroJsReduxConnect) {
            const args = declaration.arguments as t.Identifier[]
            if (args.length === 1 && args[0].name === componentClassName) {
              needExportDefault = true
              exportTaroReduxConnected = `${componentClassName}__Connected`
              astPath.replaceWith(t.variableDeclaration('const', [t.variableDeclarator(t.identifier(`${componentClassName}__Connected`), t.callExpression(declaration.callee as t.Expression, declaration.arguments as Array<t.Expression | t.SpreadElement>))]))
            }
          }
        }
      }
    },

    ExportNamedDeclaration (astPath) {
      const node = astPath.node
      const source = node.source
      if (source && source.type === 'StringLiteral') {
        const value = source.value
        analyzeImportUrl({ astPath, value, sourceFilePath, filePath, styleFiles, scriptFiles, jsonFiles, mediaFiles })
      }
    },

    ExportAllDeclaration (astPath) {
      const node = astPath.node
      const source = node.source
      if (source && source.type === 'StringLiteral') {
        const value = source.value
        analyzeImportUrl({ astPath, value, sourceFilePath, filePath, styleFiles, scriptFiles, jsonFiles, mediaFiles })
      }
    },

    Program: {
      exit (astPath) {
        astPath.traverse({
          ImportDeclaration (astPath) {
            const node = astPath.node
            const source = node.source
            const value = source.value
            analyzeImportUrl({ astPath, value, sourceFilePath, filePath, styleFiles, scriptFiles, jsonFiles, mediaFiles })
          },
          CallExpression (astPath) {
            const node = astPath.node
            const callee = node.callee as t.Identifier
            if (callee.name === 'require') {
              const args = node.arguments as t.StringLiteral[]
              const value = args[0].value
              const valueExtname = path.extname(value)
              if (value.indexOf('.') === 0) {
                let importPath = path.resolve(path.dirname(sourceFilePath), value)
                importPath = resolveScriptPath(importPath)
                if (isFileToBePage(importPath)) {
                  if (astPath.parent.type === 'AssignmentExpression' || 'ExpressionStatement') {
                    astPath.parentPath.remove()
                  } else if (astPath.parent.type === 'VariableDeclarator') {
                    astPath.parentPath.parentPath.remove()
                  } else {
                    astPath.remove()
                  }
                } else {
                  if (REG_STYLE.test(valueExtname)) {
                    const stylePath = path.resolve(path.dirname(sourceFilePath), value)
                    if (styleFiles.indexOf(stylePath) < 0) {
                      styleFiles.push(stylePath)
                    }
                    if (astPath.parent.type === 'AssignmentExpression' || 'ExpressionStatement') {
                      astPath.parentPath.remove()
                    } else if (astPath.parent.type === 'VariableDeclarator') {
                      astPath.parentPath.parentPath.remove()
                    } else {
                      astPath.remove()
                    }
                  } else if (REG_JSON.test(valueExtname)) {
                    const vpath = path.resolve(sourceFilePath, '..', value)
                    if (jsonFiles.indexOf(vpath) < 0) {
                      jsonFiles.push(vpath)
                    }
                    if (fs.existsSync(vpath)) {
                      const obj = JSON.parse(fs.readFileSync(vpath).toString())
                      let objArr: t.NullLiteral | t.Expression = t.nullLiteral()
                      if (Array.isArray(obj)) {
                        objArr = t.arrayExpression(convertArrayToAstExpression(obj))
                      } else {
                        objArr = t.objectExpression(convertObjectToAstExpression(obj))
                      }
                      astPath.replaceWith(t.objectExpression(objArr as any))
                    }
                  } else if (REG_SCRIPT.test(valueExtname) || REG_TYPESCRIPT.test(valueExtname)) {
                    const vpath = path.resolve(sourceFilePath, '..', value)
                    let fPath = value
                    if (fs.existsSync(vpath) && vpath !== sourceFilePath) {
                      fPath = vpath
                    }
                    if (scriptFiles.indexOf(fPath) < 0) {
                      scriptFiles.push(fPath)
                    }
                  } else if (REG_FONT.test(valueExtname) || REG_IMAGE.test(valueExtname) || REG_MEDIA.test(valueExtname)) {
                    const vpath = path.resolve(sourceFilePath, '..', value)
                    if (mediaFiles.indexOf(vpath) < 0) {
                      mediaFiles.push(vpath)
                    }
                    let sourceDirPath = sourceDir
                    if (NODE_MODULES_REG.test(vpath)) {
                      sourceDirPath = nodeModulesPath
                    }
                    astPath.replaceWith(t.stringLiteral(vpath.replace(sourceDirPath, '').replace(/\\/g, '/')))
                  } else {
                    let vpath = resolveScriptPath(path.resolve(sourceFilePath, '..', value))
                    let outputVpath
                    if (NODE_MODULES_REG.test(vpath)) {
                      outputVpath = vpath.replace(nodeModulesPath, npmOutputDir)
                    } else {
                      outputVpath = vpath.replace(sourceDir, outputDir)
                    }
                    let relativePath = path.relative(filePath, outputVpath)
                    if (vpath) {
                      if (!fs.existsSync(vpath)) {
                        printLog(processTypeEnum.ERROR, '引用文件', `文件 ${sourceFilePath} 中引用 ${value} 不存在！`)
                      } else {
                        if (fs.lstatSync(vpath).isDirectory()) {
                          if (fs.existsSync(path.join(vpath, 'index.js'))) {
                            vpath = path.join(vpath, 'index.js')
                            relativePath = path.join(relativePath, 'index.js')
                          } else {
                            printLog(processTypeEnum.ERROR, '引用目录', `文件 ${sourceFilePath} 中引用了目录 ${value}！`)
                            return
                          }
                        }
                        if (scriptFiles.indexOf(vpath) < 0) {
                          scriptFiles.push(vpath)
                        }
                        relativePath = promoteRelativePath(relativePath)
                        relativePath = relativePath.replace(path.extname(relativePath), '.js')
                        args[0].value = relativePath
                      }
                    }
                  }
                }
              }
            }
          }
        })
        const node = astPath.node as t.Program
        const exportVariableName = exportTaroReduxConnected || componentClassName
        if (needExportDefault && buildAdapter !== BUILD_TYPES.QUICKAPP) {
          const exportDefault = template(`export default ${exportVariableName}`, babylonConfig as any)()
          node.body.push(exportDefault as any)
        }
        const taroMiniAppFrameworkPath = !npmSkip ? getExactedNpmFilePath({
          npmName: taroMiniAppFramework,
          filePath,
          isProduction,
          npmConfig,
          buildAdapter,
          npmOutputDir,
          compileInclude
        }) : taroMiniAppFramework
        switch (type) {
          case PARSE_AST_TYPE.ENTRY:
            const pxTransformConfig = {
              designWidth: projectConfig.designWidth || 750
            }
            if (projectConfig.hasOwnProperty(DEVICE_RATIO_NAME)) {
              pxTransformConfig[DEVICE_RATIO_NAME] = projectConfig.deviceRatio
            }
            if (buildAdapter === BUILD_TYPES.QUICKAPP) {
              node.body.push(template(`export default require('${taroMiniAppFrameworkPath}').default.createApp(${exportVariableName})`, babylonConfig as any)() as any)
            } else {
              node.body.push(template(`App(require('${taroMiniAppFrameworkPath}').default.createApp(${exportVariableName}))`, babylonConfig as any)() as any)
            }
            node.body.push(template(`Taro.initPxTransform(${JSON.stringify(pxTransformConfig)})`, babylonConfig as any)() as any)
            break
          case PARSE_AST_TYPE.PAGE:
            if (buildAdapter === BUILD_TYPES.WEAPP) {
              node.body.push(template(`Component(require('${taroMiniAppFrameworkPath}').default.createComponent(${exportVariableName}, true))`, babylonConfig as any)() as any)
            } else if (buildAdapter === BUILD_TYPES.QUICKAPP) {
              node.body.push(template(`export default require('${taroMiniAppFrameworkPath}').default.createComponent(${exportVariableName}, true)`, babylonConfig as any)() as any)
            } else {
              node.body.push(template(`Page(require('${taroMiniAppFrameworkPath}').default.createComponent(${exportVariableName}, true))`, babylonConfig as any)() as any)
            }
            break
          case PARSE_AST_TYPE.COMPONENT:
            if (buildAdapter === BUILD_TYPES.QUICKAPP) {
              node.body.push(template(`export default require('${taroMiniAppFrameworkPath}').default.createComponent(${exportVariableName})`, babylonConfig as any)() as any)
            } else {
              node.body.push(template(`Component(require('${taroMiniAppFrameworkPath}').default.createComponent(${exportVariableName}))`, babylonConfig as any)() as any)
            }
            break
          default:
            break
        }
      }
    }
  })
  return {
    code: generate(ast).code,
    styleFiles,
    scriptFiles,
    jsonFiles,
    configObj,
    mediaFiles,
    componentClassName
  }
}

export function parseComponentExportAst (ast: t.File, componentName: string, componentPath: string, componentType: string): string | null {
  const {
    constantsReplaceList
  } = getBuildData()
  let componentRealPath: string | null = null
  let importExportName
  ast = babel.transformFromAst(ast, '', {
    plugins: [
      [require('babel-plugin-transform-define').default, constantsReplaceList]
    ]
  }).ast as t.File
  traverse(ast, {
    ExportNamedDeclaration (astPath) {
      const node = astPath.node
      const specifiers = node.specifiers
      const source = node.source
      if (source && source.type === 'StringLiteral') {
        specifiers.forEach(specifier => {
          const exported = specifier.exported
          if (_.kebabCase(exported.name) === componentName) {
            componentRealPath = resolveScriptPath(path.resolve(path.dirname(componentPath), source.value))
          }
        })
      } else {
        specifiers.forEach(specifier => {
          const exported = specifier.exported
          if (_.kebabCase(exported.name) === componentName) {
            importExportName = exported.name
          }
        })
      }
    },

    ExportDefaultDeclaration (astPath) {
      const node = astPath.node
      const declaration = node.declaration as t.Identifier
      if (componentType === 'default') {
        importExportName = declaration.name
      }
    },

    CallExpression (astPath) {
      if (astPath.get('callee').isIdentifier({ name: 'require' })) {
        const arg = astPath.get('arguments')[0]
        if (t.isStringLiteral(arg.node)) {
          componentRealPath = resolveScriptPath(path.resolve(path.dirname(componentPath), arg.node.value))
        }
      }
    },

    Program: {
      exit (astPath) {
        astPath.traverse({
          ImportDeclaration (astPath) {
            const node = astPath.node
            const specifiers = node.specifiers
            const source = node.source
            if (importExportName) {
              specifiers.forEach(specifier => {
                const local = specifier.local
                if (local.name === importExportName) {
                  componentRealPath = resolveScriptPath(path.resolve(path.dirname(componentPath), source.value))
                }
              })
            }
          }
        })
      }
    }
  })
  return componentRealPath
}