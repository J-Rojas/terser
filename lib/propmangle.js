/***********************************************************************

  A JavaScript tokenizer / parser / beautifier / compressor.
  https://github.com/mishoo/UglifyJS2

  -------------------------------- (C) ---------------------------------

                           Author: Mihai Bazon
                         <mihai.bazon@gmail.com>
                       http://mihai.bazon.net/blog

  Distributed under the BSD license:

    Copyright 2012 (c) Mihai Bazon <mihai.bazon@gmail.com>

    Redistribution and use in source and binary forms, with or without
    modification, are permitted provided that the following conditions
    are met:

        * Redistributions of source code must retain the above
          copyright notice, this list of conditions and the following
          disclaimer.

        * Redistributions in binary form must reproduce the above
          copyright notice, this list of conditions and the following
          disclaimer in the documentation and/or other materials
          provided with the distribution.

    THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER “AS IS” AND ANY
    EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
    IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
    PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE
    LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY,
    OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
    PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
    PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
    THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
    TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF
    THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
    SUCH DAMAGE.

 ***********************************************************************/

"use strict";
/* global global, self */
/*eslint-env node*/

import {
    defaults,
    push_uniq,
} from "./utils/index.js";
import { base54 } from "./scope";
import {
    AST_Call,
    AST_Conditional,
    AST_Dot,
    AST_Export,    
    AST_Import,
    AST_NameMapping,       
    AST_ObjectKeyVal,
    AST_ObjectProperty,
    AST_PropAccess,        
    AST_Sequence,
    AST_String,
    AST_Sub,
    AST_Symbol,         
    TreeTransformer,
    TreeWalker
} from "./ast.js";
import { domprops } from "../tools/domprops.js";


function find_builtins(reserved) {
    domprops.forEach(add);

    // Compatibility fix for some standard defined globals not defined on every js environment
    var new_globals = ["Symbol", "Map", "Promise", "Proxy", "Reflect", "Set", "WeakMap", "WeakSet"];
    var objects = {};
    var global_ref = typeof global === "object" ? global : self;

    new_globals.forEach(function (new_global) {
        objects[new_global] = global_ref[new_global] || new Function();
    });

    // NaN will be included due to Number.NaN
    [
        "null",
        "true",
        "false",
        "Infinity",
        "-Infinity",
        "undefined",
    ].forEach(add);
    [ Object, Array, Function, Number,
      String, Boolean, Error, Math,
      Date, RegExp, objects.Symbol, ArrayBuffer,
      DataView, decodeURI, decodeURIComponent,
      encodeURI, encodeURIComponent, eval, EvalError,
      Float32Array, Float64Array, Int8Array, Int16Array,
      Int32Array, isFinite, isNaN, JSON, objects.Map, parseFloat,
      parseInt, objects.Promise, objects.Proxy, RangeError, ReferenceError,
      objects.Reflect, objects.Set, SyntaxError, TypeError, Uint8Array,
      Uint8ClampedArray, Uint16Array, Uint32Array, URIError,
      objects.WeakMap, objects.WeakSet
    ].forEach(function(ctor) {
        Object.getOwnPropertyNames(ctor).map(add);
        if (ctor.prototype) {
            Object.getOwnPropertyNames(ctor.prototype).map(add);
        }
    });
    function add(name) {
        reserved.add(name);
    }
}

function reserve_quoted_keys(ast, reserved) {
    function add(name) {
        push_uniq(reserved, name);
    }

    ast.walk(new TreeWalker(function(node) {
        if (node instanceof AST_ObjectKeyVal && node.quote) {
            add(node.key);
        } else if (node instanceof AST_ObjectProperty && node.quote) {
            add(node.key.name);
        } else if (node instanceof AST_Sub) {
            addStrings(node.property, add);
        }
    }));
}

function addStrings(node, add) {
    node.walk(new TreeWalker(function(node) {
        if (node instanceof AST_Sequence) {
            addStrings(node.tail_node(), add);
        } else if (node instanceof AST_String) {
            add(node.value);
        } else if (node instanceof AST_Conditional) {
            addStrings(node.consequent, add);
            addStrings(node.alternative, add);
        }
        return true;
    }));
}

function expressionName(node) {    
    if (node instanceof AST_Symbol) {        
        return node.name;
    } else if (node instanceof AST_PropAccess) {
        //console.log("AST_PropAccess.property " + node.property);
        return node.property;
    } else if (node instanceof AST_ObjectKeyVal) {
        return node.key;
    } else if (node instanceof AST_ObjectProperty) {
        return node.key.name;
    } else if (node instanceof AST_NameMapping) {
        return expressionName(node.foreign_name);
    } else {
        return null;
    }    
}

function setExpressionName(node, value) {    
    if (node instanceof AST_Symbol) {
        var def = node.definition();
        if (def) {
            def.mangled_name = value;
        } else {
            node.name = value;
        }                            
    } else if (node instanceof AST_PropAccess) {        
        node.property = value;
    } else if (node instanceof AST_ObjectKeyVal) {
        node.key = value;
    } else if (node instanceof AST_ObjectProperty) {
        node.key.name = value;
    } else if (node instanceof AST_NameMapping) {
        setExpressionName(node.foreign_name, value);
    } else {
        console.log("Unknown type '" + node.__proto__.TYPE + "'");     
    }    
}

function DEBUG(msg, verbose) {
    if (verbose) console.log(msg);
}

function mangle_properties(ast, options) {
    options = defaults(options, {
        builtins: false,
        cache: null,
        debug: false,
        keep_quoted: false,
        only_cache: false,
        regex: null,
        reserved: null,
        undeclared: false,
        exports: false,
        verbose: false,
        excludeParents: [],
        includeParents: []
    }, true);

    var verbose = options.verbose;
    var mangleExports = options.exports;    
    var reserved_option = options.reserved;
    if (!Array.isArray(reserved_option)) reserved_option = [reserved_option];
    var reserved = new Set(reserved_option);
    var excludeParents_option = options.excludeParents;
    if (!Array.isArray(excludeParents_option)) excludeParents_option = [excludeParents_option];    
    var excludeParents = new Set(excludeParents_option);
    var includeParents_option = options.includeParents;
    if (!Array.isArray(includeParents_option)) includeParents_option = [includeParents_option];    
    var includeParents = new Set(includeParents_option.map(it => {
        if (typeof it === "string") {
            return it;
        } else {
            return it.name;
        }
    }));
    var includeParentsMap = new Map(includeParents_option.map(it => {
        if (typeof it === "string") {
            return [it, {index: 0}];
        } else {
            return [it.name, it];
        }
    }));
    // add Object.defineProperty call to includeParents
    includeParents.add("Object.defineProperty");
    includeParentsMap.set("Object.defineProperty", { index: 1 });

    DEBUG(includeParentsMap, verbose);

    if (!options.builtins) find_builtins(reserved);

    var cname = -1;
    var cache;
    if (options.cache) {
        cache = options.cache.props;
        cache.forEach(function(mangled_name) {
            reserved.add(mangled_name);
        });
    } else {
        cache = new Map();
    }

    var regex = options.regex && new RegExp(options.regex);

    // note debug is either false (disabled), a string of the debug suffix to use (enabled),
    // or an object with prefix and suffix properties (enabled).
    // note debug may be enabled as an empty string, which is falsey. Also treat passing 'true'
    // the same as passing an empty string.
    var debug = options.debug !== false;
    var debug_name_suffix;
    var debug_name_prefix;
    if (debug) {

        if (typeof(options.debug) == "object")
            debug_name_prefix = options.debug.prefix;
        else
            debug_name_prefix = "_$";

        if (typeof(options.debug) == "object")
            debug_name_suffix = options.debug.suffix;
        else
            debug_name_suffix = (options.debug === true ? "$_" : "$" + options.debug + "_");
    }

    var names_to_mangle = new Set();
    var unmangleable = new Set();
    var excludedNodes = new Set();

    var keep_quoted_strict = options.keep_quoted === "strict";

    // step 1: find candidates to mangle
    var walker = new TreeWalker();
    walker.visit = function(node) {

        if (excludeParents_option.length > 0) {
            var key;
            var parent;
            if (node instanceof AST_ObjectKeyVal) {
                key = node.key;
                parent = walker.parent(1);
            } else if (node instanceof AST_ObjectProperty) {
                key = node.key.name;
                parent = node.expression;
            } else if (node instanceof AST_Dot) {
                key = node.property;
                parent = node.expression;
            }

            if (key) {
                if (excludeParents.has(key)) {            
                    DEBUG("Found excluded parent: " + key, verbose);
                    //console.log(parent);
                }                
                var parentName = expressionName(parent);
                var parentExcluded = parentName && excludeParents.has(parentName);
                if (parentExcluded) {
                    DEBUG("parent excluded: " + key, verbose);
                    excludedNodes.add(node);
                }
            }
        }

        if (node instanceof AST_Export && mangleExports) {
            //find any definitions that need name mangling
            var exported = node.exported_definition || node.exported_value;
            DEBUG("searching exports... : ", verbose);
            var found = false;            
            while (exported) {                     
                if (typeof exported.name == "string") {                    
                    add(exported.name, add);
                    DEBUG("   export mangling : " + exported.name, verbose);
                    found = true;
                    exported = null;
                } else {
                    if (exported.name)
                        exported = exported.name;
                    else {
                        exported = exported.definitions;
                        if (Array.isArray(exported)) {
                            DEBUG("   array definitions ", verbose);
                            exported = exported[0];
                        }
                    }
                }
            }
            if (node.exported_names) {
                node.exported_names.forEach(it => {
                    var name = expressionName(it);
                    if (name !== "*") {
                        DEBUG("   export mangling : " + name, verbose);
                        add(name, add);
                    }
                });
                found = true;
            }
            if (!found) {
                DEBUG(node, verbose);
            }          
        } else if (node instanceof AST_Import && mangleExports) {
            if (node.imported_names) {
                node.imported_names.forEach(it => {
                    var name = expressionName(it);
                    if (name !== "*") {
                        DEBUG("   import mangling : " + name, verbose);
                        add(name, add);
                    }
                });
                found = true;
            }
        } else if (node instanceof AST_ObjectKeyVal) {
            if (typeof node.key == "string" &&
                (!keep_quoted_strict || !node.quote)) {
                add(node.key);
            }
        } else if (node instanceof AST_ObjectProperty) {
            // setter or getter, since KeyVal is handled above
            if (!keep_quoted_strict || !node.key.end.quote) {
                add(node.key.name);
            }
        } else if (node instanceof AST_Dot) {
            var declared = !!options.undeclared;
            if (!declared) {
                var root = node;
                while (root.expression) {
                    root = root.expression;
                }
                declared = !(root.thedef && root.thedef.undeclared);
            }
            if (declared &&
                (!keep_quoted_strict || !node.quote)) {
                add(node.property);
            }
        } else if (node instanceof AST_Sub) {
            if (!keep_quoted_strict) {
                addStrings(node.property, add);
            }
        } else if (node instanceof AST_Call) {
            var str;
            if (((str = node.expression.print_to_string()) && includeParents.has(str)) || 
                ((str = expressionName(node.expression)) && includeParents.has(str))) {
                DEBUG("include parent: '" + str + "'", verbose);
                DEBUG("   value: " + node.args[includeParentsMap.get(str).index].print_to_string(), verbose);
                addStrings(node.args[includeParentsMap.get(str).index], add);
            }
        }
    };
    ast.walk(walker);

    // step 2: transform the tree, renaming properties
    return ast.transform(new TreeTransformer(function(node) {
        if (excludedNodes.has(node)) {
            return;
        }
        if (node instanceof AST_Export && mangleExports) {
            //find any definitions that need name mangling
            var exported = node.exported_definition || node.exported_value;
            DEBUG("searching exports (for transform)... : ", verbose);
            var found = false;
            while (exported) {              
                if (typeof(exported.name) === "string") {
                    var mangled = mangle(exported.name);                    
                    setExpressionName(exported, mangled);
                    DEBUG("   export mangling : " + exported.print_to_string() + " type: " + exported.__proto__.TYPE, verbose);
                    exported = null;
                    found = true;
                } else {
                    if (exported.name)
                        exported = exported.name;
                    else {
                        exported = exported.definitions;                    
                        if (Array.isArray(exported)) {
                            DEBUG("   array definitions ", verbose);
                            exported = exported[0];
                        }
                    }
                }
            }     
            if (node.exported_names) {
                node.exported_names.forEach(it => {
                    var name = expressionName(it);
                    if (name !== "*") {
                        var mangled = mangle(name);
                        setExpressionName(it, mangled);
                        DEBUG("   export mangling : " + it.print_to_string(), verbose);
                    }
                });
                found = true;
            }
            if (!found) {
                DEBUG(node, verbose);
            }       
        } else if (node instanceof AST_Import && mangleExports) {
            if (node.imported_names) {
                node.imported_names.forEach(it => {
                    var name = expressionName(it);
                    if (name !== "*") {
                        var mangled = mangle(name);
                        setExpressionName(it, mangled);
                        DEBUG("   import mangling : " + it.print_to_string(), verbose);
                    }
                });
                found = true;
            }
        } else if (node instanceof AST_ObjectKeyVal) {
            if (typeof node.key == "string" &&
                (!keep_quoted_strict || !node.quote)) {
                node.key = mangle(node.key);
            }
        } else if (node instanceof AST_ObjectProperty) {
            // setter or getter
            if (!keep_quoted_strict || !node.key.end.quote) {
                node.key.name = mangle(node.key.name);
            }
        } else if (node instanceof AST_Dot) {
            if (!keep_quoted_strict || !node.quote) {
                node.property = mangle(node.property);
            }
        } else if (!options.keep_quoted && node instanceof AST_Sub) {
            node.property = mangleStrings(node.property);
        } else if (node instanceof AST_Call) {
            var str;
            if (((str = node.expression.print_to_string()) && includeParents.has(str)) || 
                ((str = expressionName(node.expression)) && includeParents.has(str))) {                
                DEBUG("include parent: '" + str + "'", verbose);
                DEBUG("   value: " + node.args[includeParentsMap.get(str).index].print_to_string(), verbose);
                node.args[includeParentsMap.get(str).index] = mangleStrings(node.args[includeParentsMap.get(str).index]);    
            }
        }
    }));

    // only function declarations after this line

    function can_mangle(name) {
        if (unmangleable.has(name)) return false;
        if (reserved.has(name)) return false;
        if (options.only_cache) {
            return cache.has(name);
        }
        if (/^-?[0-9]+(\.[0-9]+)?(e[+-][0-9]+)?$/.test(name)) return false;
        return true;
    }

    function should_mangle(name) {
        if (regex && !regex.test(name)) return false;
        if (reserved.has(name)) return false;
        return cache.has(name)
            || names_to_mangle.has(name);
    }

    function add(name) {
        if (can_mangle(name))
            names_to_mangle.add(name);

        if (!should_mangle(name)) {
            unmangleable.add(name);
        }
    }

    function mangle(name) {
        if (!should_mangle(name)) {
            return name;
        }

        var mangled = cache.get(name);
        if (!mangled) {
            if (debug) {
                // debug mode: use a prefix and suffix to preserve readability, e.g. o.foo -> o._$foo$NNN_.
                var debug_mangled = debug_name_prefix + name + debug_name_suffix;

                if (can_mangle(debug_mangled)) {
                    mangled = debug_mangled;
                }
            }

            // either debug mode is off, or it is on and we could not use the mangled name
            if (!mangled) {
                do {
                    mangled = base54(++cname);
                } while (!can_mangle(mangled));
            }

            cache.set(name, mangled);
        }
        return mangled;
    }

    function mangleStrings(node) {
        return node.transform(new TreeTransformer(function(node) {
            if (node instanceof AST_Sequence) {
                var last = node.expressions.length - 1;
                node.expressions[last] = mangleStrings(node.expressions[last]);
            } else if (node instanceof AST_String) {
                node.value = mangle(node.value);
            } else if (node instanceof AST_Conditional) {
                node.consequent = mangleStrings(node.consequent);
                node.alternative = mangleStrings(node.alternative);
            }
            return node;
        }));
    }
}

export {
    reserve_quoted_keys,
    mangle_properties,
};
