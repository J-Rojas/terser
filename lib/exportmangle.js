/***********************************************************************
   
                           Author: Jose Rojas
                         <jrojas@redlinesolutions.co>                       

  Distributed under the BSD license:

    Copyright 2019 (c) Jose Rojas <jrojas@redlinesolutions.co>

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

import {
    defaults    
} from "./utils/index.js";
import {
    DEBUG,
    mangle_helpers,
    expressionName,
    setExpressionName,
    find_builtins
} from "./mangle.js";
import {
    AST_Export,    
    AST_Import,
    TreeTransformer,
    TreeWalker
} from "./ast.js";


export function mangle_exports(ast, options, verbose) {
    options = defaults(options, {
        builtins: false,
        cache: null,
        debug: false,
        excluded: false,    
        excludedModules: null,    
        reserved: null        
    }, true);
    
    var reserved_option = options.reserved;
    if (!Array.isArray(reserved_option)) reserved_option = [reserved_option];
    var reserved = new Set(reserved_option);

    var excludedExports = new Set(options.excluded || []);
    // add '*' to excluded exports
    excludedExports.add("*");

    var excludedModules = new Set(options.excludedModules || []);

    if (!options.builtins) find_builtins(reserved);
    
    var {
        add,
        mangle                   
    } = mangle_helpers(options, reserved, options.cache ? options.cache.exports : null);

    // step 1: find candidates to mangle
    var walker = new TreeWalker();
    walker.visit = function(node) {

        if (node instanceof AST_Export) {
            //find any definitions that need name mangling
            var exported = node.exported_definition || node.exported_value;
            DEBUG("searching exports... : ", verbose);
            var found = false;            
            while (exported) {                     
                if (typeof exported.name == "string" && !excludedExports.has(exported.name)) {                    
                    add(exported.name, true);
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
                    if (!excludedExports.has(name)) {
                        DEBUG("   export mangling : " + name, verbose);
                        add(name, true);
                    }
                });
                found = true;
            }
            if (!found) {
                DEBUG(node, verbose);
            }          
        } else if (node instanceof AST_Import) {            
            var moduleName = node.module_name.print_to_string();
            var result = moduleName.match(/"(.+)"/);
            moduleName = result[1];            
            if (!excludedModules.has(moduleName)) {
                if (node.imported_names) {
                    node.imported_names.forEach(it => {
                        var name = expressionName(it);
                        if (!excludedExports.has(name)) {
                            DEBUG("   import mangling : " + name, verbose);
                            add(name, true);
                        }
                    });
                    found = true;
                }        
            }                    
        }
    };
    ast.walk(walker);
    
    // step 2: transform the tree, renaming properties
    var tree = ast.transform(new TreeTransformer(function(node) {
    
        if (node instanceof AST_Export) {
            //find any definitions that need name mangling
            var exported = node.exported_definition || node.exported_value;
            DEBUG("searching exports (for transform)... : ", verbose);
            var found = false;
            while (exported) {              
                if (typeof(exported.name) === "string" && !excludedExports.has(exported.name)) {
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
                    if (!excludedExports.has(name)) {
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
        } else if (node instanceof AST_Import) {                                
            const moduleName = node.module_name.print_to_string();
            if (!excludedModules.has(moduleName)) {
                if (node.imported_names) {
                    node.imported_names.forEach(it => {
                        var name = expressionName(it);
                        if (!excludedExports.has(name)) {
                            var mangled = mangle(name);
                            setExpressionName(it, mangled);
                            DEBUG("   import mangling : " + it.print_to_string(), verbose);
                        }
                    });
                    found = true;
                }
            }            
        }
    }));

    // copy exports to props cache    
    for (var [key, value] of options.cache.exports) {
        options.cache.props.set(key, value);
    }

    return tree;
}