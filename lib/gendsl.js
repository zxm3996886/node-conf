// 
//        Copyright 2010-2011 Johan Dahlberg. All rights reserved.
//
//  Redistribution and use in source and binary forms, with or without 
//  modification, are permitted provided that the following conditions 
//  are met:
//
//    1. Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//
//    2. Redistributions in binary form must reproduce the above copyright 
//       notice, this list of conditions and the following disclaimer in the 
//       documentation and/or other materials provided with the distribution.
//
//  THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, 
//  INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY 
//  AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL 
//  THE AUTHORS OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, 
//  SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED 
//  TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR 
//  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF 
//  LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING 
//  NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE,
//  EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
//

const createScript          = require("vm").createScript
    , readFileSync          = require("fs").readFileSync
    , statSync              = require("fs").statSync
    , join                  = require("path").join
    , normalize             = require("path").normalize
    , dirname               = require("path").dirname
    , basename              = require("path").basename;

const slice                 = Array.prototype.slice;

const NIL                   = {};

const WRAPPER_TMPL          = "with (__props) {%s;\n}";

const REQUIRED_RE           = /^[A-Z]*$/
    , RESERVED_NAMES_RE     = /^(end|include)$/
    , PARAM_REQUIRED_RE     = /^(struct|section|expression|custom)/
    , BYTESIZE_RE           = /^([\d\.]+)(b|kb|mb|gb)$|^([\d\.]+)$/
    , TIMEUNIT_RE           = /^([\d\.]+)(ms|s|m|h|d)$|^([\d\.]+)$/;

const NATIVE_TYPE_MAPPING   = 
      [ Boolean, "boolean"
      , String, "string"
      , Number, "number"
      , Array, "array"
      , Object, "object"
      , RegExp, "regexp"
      ];

const PROPERTY_TYPES        = 
      [ "boolean"
      , "string"
      , "number"
      , "array"
      , "object"
      , "regexp"
      , "section"
      , "expression"
      , "path"
      , "static"
      , "struct"
      , "wildcard"
      , "custom"
      , "bytesize"
      , "timeunit"
      ];


exports.createContext = function(markup) {
  var context = new ConfigContext();
  
  if (!markup) {
    throw new Error("Expected 'markup'.");
  }
  
  updateSection(context, markup);

  return context;
}

exports.createScript = function(path, filename) {
  var resolvedPath;
  var script;

  resolvedPath = resolvePath(path, process.cwd());
  script  = new DslScript(resolvedPath, filename);
  
  return script;
}


function DslScript(path, filename) {
  this.code = readFileSync(path, "utf8");
  this.filename = filename || basename(path);
  this.workdir = dirname(path);
  this.strict = false;
  this.paths = [];
  this.isolated = false;
}

DslScript.prototype.runInContext = function(context, env) {
  var sandbox;
  var runtime;
  var result;
  
  if (!context || !context instanceof ConfigContext) {
    throw new Error("Expected a ConfigContext as context");
  }
  
  runtime = new Runtime( context
                       , this.workdir
                       , this.paths
                       , this.strict
                       , this.isolated);
  

  sandbox = createSandbox(runtime, env || {});

  runtime.push(context);
  
  runScript(sandbox, this.code, this.filename);

  while ((result = runtime.pop()) && runtime.currentScope);
  
  return result;
}


// Runtime
function Runtime(context, workdir, paths, strict, isolated) {
  this.context = context;
  this.workdir = workdir;
  this.paths = paths;
  this.strict = strict;
  this.isolated = isolated;

  this.resultStack = [];
  this.currentResult = null;

  this.scopeStack = [];
  this.currentScope = null;

  this.indexStack = [];
  this.currentIndex = null;
}

// Copy a runtime variables from specified runtime
Runtime.prototype.copy = function(runtime) {
  this.resultStack = runtime.resultStack;
  this.currentResult = runtime.currentResult;
  this.scopeStack = runtime.scopeStack;
  this.currentScope = runtime.currentScope;
  this.indexStack = runtime.indexStack;
  this.currentIndex = runtime.currentIndex;
}

// Push scope to stack
Runtime.prototype.push = function(scope) {
  this.scopeStack.push(this.currentScope);
  this.currentScope = scope;
  this.indexStack.push(this.currentIndex);
  this.currentIndex = scope.index ? [] : null;
  this.resultStack.push(this.currentResult);
  this.currentResult = {};
  return this.currentResult;
}

// Pop scope from stack
Runtime.prototype.pop = function() {
  var result = this.currentResult;
  var scope = this.currentScope;
  var index = this.currentIndex;
  this.currentResult = this.resultStack.pop();
  this.currentScope = this.scopeStack.pop();
  this.currentIndex = this.indexStack.pop();
  endScope.call(this, scope, result, index);
  return result;
}

Runtime.prototype.resolvePath = function(path) {
  var workdir = this.workdir;
  var paths = this.paths;
  var isolated = this.isolated;
  var newpath;

  if (isolated && (path[0] == "/" ||  /\.\.\//.test(path))) {
    return null;
  }
  
  function isFile(path) {
    try {
      return statSync(path).isFile();
    } catch(e) {
      return false;
    }
    return true;
  }

  if (path[0] == "/") {
    return isFile(path) && path || null;
  }
  
  if (path[0] == ".") {
    newpath = join(workdir, path);
    return isFile(newpath) && newpath || null;
  }
  
  for (var i = 0, l = paths.length; i < l; i++) {
    newpath = join(paths[i], path);
    if (isFile(newpath)) {
      return newpath;
    }
  }
  
  return null;
}



/**
 *  ## ConfigContext
 *
 *
 */
function ConfigContext() {
  this.name = "[ROOT]";
  this.root = this;
  this.parent = null;
  this.fields = {};
  this.defaults = {};
  this.requirements = {};
  this.statics = {};
  this.field = null;
  this.index = null;
                
  this.props = {};
}


// Include command implementation
function includeImpl(filename) {
  var env = typeof arguments[1] === "object" && arguments[1] || {};
  var isolated = env && arguments[2] || arguments[1];
  var resolvedPath;
  var script;
  var sandbox;
  var runtime;
  
  resolvedPath = this.resolvePath(filename);
  
  if (resolvedPath == null) {
    throw new Error("conf: Include not found '" + filename + "'");
  }
  
  try {
    script = new DslScript(resolvedPath);
  } catch (ioException) {
    throw new Error("conf: Could not include config script '" + 
                    resolvedPath  + "'.");
  }

  runtime = new Runtime( this.context
                       , script.workdir
                       , this.paths
                       , this.strict
                       , this.isolated || isolated);
  
  runtime.copy(this);

  sandbox = createSandbox(runtime, env || {});  

  runScript(sandbox, script.code, script.filename);  
  
  this.copy(runtime);
}


// Run a script in sandbox
function runScript(sandbox, code, filename) {
  var script = createScript(WRAPPER_TMPL.replace(/%s/g, code), filename);
  script.runInNewContext(sandbox);
}


// Create a new sandbox from runtime 
// and optional enviroment variables
function createSandbox(runtime, env) {
  var sandbox = { __props : {} };
  var context = runtime.context;
  var propfn;

  for (var name in context.props) {
    propfn = context.props[name].bind(runtime);
    Object.defineProperty(sandbox.__props, name, {
      get: propfn, set: propfn
    });
  }
  
  Object.defineProperty(sandbox.__props, "end", {
    get: (function() {
      var field = this.currentScope;
      var result = this.currentResult;

      this.pop();
      
      if (typeof field.onexit == "function") {
        field.onexit(this, result);
      }
      
    }).bind(runtime)
  });
  
  sandbox.include = includeImpl.bind(runtime);
  
  for (var name in env) {
    if (RESERVED_NAMES_RE(name)) {
      throw new Error("conf: Cannot define environment " +
                      "variable, name '" +  name + "' is reserved.");
    }
    sandbox[name] = env[name];
  }
  
  return sandbox;
}


// Update section with specified markup
function updateSection(scope, markup) {
  var root = scope.root;
  var keys;
  var name;
  var length;
  var field;
  var subscope;
  
  keys = Object.keys(markup);
  length = keys.length;
  
  for (var index = 0; index < length; index++) { 
    name = keys[index];
    
    if (RESERVED_NAMES_RE(name)) {
      throw new Error("conf: '" + name + "' is reserved.");
    }
    
    if (scope.fields[name] || scope.statics[name]) {
      throw new Error("conf: Property is already defined '" + name + "'");
    }

    field = getPropertyField(name, markup[name]);
    
    if (field == null) {
      throw new Error("conf[" + name + "]: Property cannot be null");
    }
    
    if (field.type == "static") {
    
      if (field.value == NIL) {
        throw new Error("conf[" + name + "]: " +
                        "Value of type static must be set");
      }
      
      scope.statics[name] = field.value;
      
      continue;
    }
    
    if (PARAM_REQUIRED_RE(field.type) && !field.param) {
      throw new Error("conf: `param`must be set for field.");
    }
    
    if (scope.type == "struct" && name !== scope.property) {
      throw new Error("conf[" + name + "]:" + 
                      "Struct's cannot contain dynamic properties.");
    }

    if (field.value !== NIL) {
      scope.defaults[name] = field.value;
    }

    if (field.required) {
      scope.requirements[name] = true;
    }

    field.root = root;
    field.parent = scope;

    if (field.type === "section" || field.type == "struct") {
      field.fields = {};
      field.defaults = {};
      field.requirements = {};
      field.statics = {};

      updateSection(field, field.param);
      
      if (field.property) {

        if (typeof field.property !== "string") {
          throw new Error( "conf-markup[" + name + "]: Expected a string "
                         + "value for section 'property'.");
        }        
      }
      
      if (field.index) {
        if (typeof field.index !== "string") {
          throw new Error( "conf-markup[" + name + "]: Expected a string "
                         + "value for section 'index'.");
        }        
      }
              
    } 
    
    if (!root.props[name]) {
      root.props[name] = createProp(name);      
    }

    scope.fields[name] = field;
  }
}


// Create a new property wrapper
function createProp(name) {
  return function(value) {
    var args = slice.call(arguments);
    var scope = this.currentScope;
    var field;
    var prop;

    if (!scope || !scope.fields || 
        !(field = scope.fields[name])) {
      throw new Error("conf: Property '" + name + 
                      "' cannot be defined in section '" + scope.name + "'");
    }

    if (field.type == "section" || field.type == "struct") {
      this.push(field);

      if (field.property) {

        if (!(prop = field.fields[field.property])) {
          throw new Error("conf: Property field not found: " + field.property);
        }

        applyResult.call(this, prop, value);
      }

      if (typeof field.onenter == "function") {
        field.onenter(this, this.currentResult);
      }

      if (field.type == "struct") {
        this.pop();
      }
      
    } else {
      
      return applyResult.call(this, field, value);
    }
  }
}


// Apply result to current result set
function applyResult(field, value) {
  var name = field.name;
  var result = this.currentResult;
  var index = !field.idxignore && this.currentIndex;
  var validated;

  if (field.list) {
    
    if (!(name in result)) {
      result[name] = [];
    }
    
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        validated = validateValue.call(this, field, value[i]);
        result[name].push(validated);
        index && (index[index.length] = validated);
      }
    } else {
      validated = validateValue.call(this, field, value);
      result[name].push(validated);
      index && (index[index.length] = validated);
    }

  } else if (name in result) {
    throw new Error("conf[" + name + "]: Expected one value only");
  } else {
    validated = validateValue.call(this, field, value);
    result[name] = validated
    index && (index[index.length] = validated);
  }

  return validated;
}


// End scope
function endScope(scope, result, index) {
  var self = this;
  var defvalue;
  var keys;
  var key;
  var length;
  var field;

  keys = Object.keys(scope.fields);
  length = keys.length;
  
  while (length--) {
    key = keys[length];
    field = scope.fields[key];

    if (!(key in result)) {
      if (key in scope.defaults) {
        if (field.list) {
          result[key] = [];
          if (Array.isArray(scope.defaults[key])) {
            scope.defaults[key].forEach(function(val) {
              var validated = validateValue.call(self, field, val);
              result[key].push(val);
              index && (index[index.length] = val);
            });
          } else {
            defvalue = scope.defaults[key];
            result[key].push(validateValue.call(self, field, defvalue));
          }
        } else {
          defvalue = scope.defaults[key];
          result[key] = validateValue.call(self, field, defvalue);
        }
      } else if (field.list && !field.required) {
        result[key] = [];
      }
    }
  }

  keys = Object.keys(scope.requirements);
  length = keys.length;
  
  while (length--) {
    key = keys[length];
    if (!(key in result)) {
      throw new Error("conf: Required property '" + key + "' was not set.");
    }
  }

  keys = Object.keys(scope.statics);
  length = keys.length;
  
  while (length--) {
    key = keys[length];
    result[key] = scope.statics[key];
  }
  
  if (scope.index) {
    result[scope.index] = index;
  }
  
  if (scope.parent) {
    applyResult.call(this, scope, result);
  }
}


// Get a struct from expression
function getPropertyField(name, expr) {
  var type = null;
  var required = false;
  var list = false;
  var value = NIL;
  var param = null;
  var index = null;
  var property = null;
  var strict = false;
  var idxignore = false;
  var onenter = null;
  var onexit = null;
  var ctor;
  var i;
  
  if (typeof expr == "undefined" || expr == null) {
    return null;
  }

  if (Array.isArray(expr)) {
    if (typeof expr[0] === "string") {
      type = expr[0].toLowerCase();
      required = REQUIRED_RE(expr[0]) && true || false;
    } else if (expr[0].constructor === RegExp) {
      type = "expression";
      param = expr[0];
    } else if ((i = NATIVE_TYPE_MAPPING.indexOf(expr[0])) != -1) {
      type = NATIVE_TYPE_MAPPING[i + 1];
    } else if (typeof expr[0] == "function") {
      type = "custom";
      param = epxr[0];
    }
    if (expr.length > 1) {
      value = expr[1];
    }
    list = true;
  } else if (expr.constructor === RegExp) {
    type = "expression";
    param = expr;    
  } else if (typeof expr === "string") {
    type = expr.toLowerCase();
    required = REQUIRED_RE(expr) && true || false;
  } else if ((i = NATIVE_TYPE_MAPPING.indexOf(expr)) != -1) {
    type = NATIVE_TYPE_MAPPING[i + 1];
  } else if (typeof expr == "function") {
    type = "custom";
    param = expr;
  } else {
    if (typeof expr.type === "string") {
      type = expr.type.toLowerCase();
      required = REQUIRED_RE(expr.type) && true || false; 
    } else if (expr.type && expr.type.constructor === RegExp) {
      type = "expression";
      param = expr.type;
    } else if ((i = NATIVE_TYPE_MAPPING.indexOf(expr.type)) != -1) {
      type = NATIVE_TYPE_MAPPING[i + 1];
    } else if (expr.section) {
      type = "section";
      property = expr.property;
      param = expr.section;
      index = expr.index;
    } else if (expr.struct) {
      type = "struct";
      property = expr.property;
      param = expr.struct;
    } else if (expr.type && typeof expr.type == "function") {
      type = "custom";
      param = expr.type;
    }
    required = expr.required || (REQUIRED_RE(expr) && true || false);
    // value = "value" in expr && expr.value || NIL;
    
    if ("value" in expr) {
      value = expr.value;
    } else {
      value = NIL; 
    }
    list = expr.list || false;
    param = param && param || expr.param;
    index = index && index || expr.index;
    strict = expr.strict || false;
    idxignore = expr.idxignore || false;
    onenter = expr.onenter || null;
    onexit = expr.onexit || null;
  }

  if (PROPERTY_TYPES.indexOf(type) == -1) {
    throw new Error("conf: Unknown field type: " + type);
  }
  
  return { name: name
         , type: type
         , property: property
         , list: list
         , required: required
         , param: param
         , strict: strict
         , value: value
         , idxignore: idxignore
         , index: index
         , onenter: onenter
         , onexit: onexit };
}

// Validate value against struct
function validateValue(field, value) {
  var name = this.name;
  var strict = this.strict || field.strict;
  var workdir = this.workdir;


  switch (field.type) {
    
    case "wildcard":
      return value;
      
    case "boolean":
      if (typeof value == "boolean") {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a Boolean");
      } else {
        return true;
      }
      break;

    case "string":
      if (typeof value == "string") {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a String");
      } else {
        return value.toString();
      }
      break;
      
    case "number":
      if (typeof value == "number") {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a Number");
      } else {
        return parseInt(value);
      }
      break;

    case "array":
      if (Array.isArray(value)) {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected an Array");
      } else {
        return [value];
      }
      break;
      
    case "object":
      if (typeof value == "object") {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected an Object");
      } else {
        return value;
      }
      break;
      
    case "regexp":
      if (value && value.constructor === RegExp) {
        return value;
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a RegExp");
      } else if (typeof value == "string") {
        try {
          return new RegExp(value);
        } catch (initExecption) {
          throw new Error("conf[" + name + "]: Expected a RegExp");
        }
      } else {
        throw new Error("conf[" + name + "]: Expected a RegExp");
      }
      break;
      
    case "expression":
      if (!field.param) {
        return NIL;
      }
      if (typeof value == "string") {
        if (field.param(value) == null) {
          throw new Error("conf[" + name + "]: Bad value '" + value + "'");
        } else {
          return value;
        }
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a String");
      } else {
        value = value.toString();
        if (field.param(value) == null) {
          throw new Error("conf[" + name + "]: Bad value '" + value + "'");
        } else {
          return value;
        }
      }
      break;
      
    case "path":
      if (typeof value == "string") {
        return resolvePath(value, workdir);
      } else if (strict) {
        throw new Error("conf[" + name + "]: Expected a path");
      } else {
        return resolvePath(value.toString(), workdir);
      }
      break;
      
    case "bytesize":
      if (typeof value == "number") {
        return parseInt(value);
      } else if (typeof value == "string") {
        return getBytes(value);
      } else if (strict) {
        throw new Error("Expected String or Number");
      } else {
        return getBytes(value.toString());
      }
      break;

    case "timeunit":
      if (typeof value == "number") {
        return parseInt(value);
      } else if (typeof value == "string") {
        return getMilliseconds(value);
      } else if (strict) {
        throw new Error("Expected String or Number");
      } else {
        return getMilliseconds(value.toString());
      }
      break;
      
    case "custom":
      return field.param(field, value, this);
      break;
  }
  
  return value;
}

function getBytes(expr) {
  var m  = BYTESIZE_RE(expr);

  if (!m) {
    throw new Error("Invalid bytesize expression");
  }
  
  if (m[2]) {
    switch (m[2]) {
      case "b": return parseInt(m[1]);
      case "kb": return parseFloat(m[1]) * 1024;
      case "mb": return parseFloat(m[1]) * 1024 * 1024;
      case "gb": return parseFloat(m[1]) * 1024 * 1024 * 1024;
    }
  }
  
  return parseInt(m[3]);
}

function getMilliseconds(expr) {
  var m  = TIMEUNIT_RE(expr);
  
  if (!m) {
    throw new Error("Invalid timeunit expression");
  }
  
  if (m[2]) {
    switch (m[2]) {
      case "ms": return parseInt(m[1]);
      case "s": return parseFloat(m[1]) * 1000;
      case "m": return parseFloat(m[1]) * 1000 * 60;
      case "h": return parseFloat(m[1]) * 1000 * 60 * 60;
      case "d": return parseFloat(m[1]) * 1000 * 60 * 60 * 24;
    }
  }
  
  return parseInt(m[3]);
}

// Resolve path to file
function resolvePath(path, workdir) {
  switch (path[0]) {
    default:
    case "/": return path;
    case "~": return join(process.env["HOME"], path.substr(1));
    case ".": return join(workdir, path);
  }
}