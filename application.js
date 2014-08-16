(function() {
  var host = 'http://localhost:3000';

  var request = superagent;
 
  // Some global variables (database, references to key UI elements)
  var db, input, ul;
 
  databaseOpen(function() {
    input = document.getElementsByTagName('input')[0];
    ul = document.getElementsByTagName('ul')[0];
    document.body.addEventListener('submit', onSubmit);
    document.body.addEventListener('click', onClick);
    refreshView();
    synchronize();
  });
 
  function onClick(e) {
 
    // We'll assume any element with an ID attribute
    // is a todo item. Don't try this at home!
    if (e.target.hasAttribute('id')) {
 
      // Note because the id is stored in the DOM, it becomes
      // a string so need to make it an integer again
      databaseTodosGetByLocalId(parseInt(e.target.getAttribute('id'), 10), function(todo) {
        todo.deleted = true;
        todo.updated = Date.now();
        databaseTodosPut(todo, function() {
          refreshView();
          synchronize();
        });
      });
    }
  }
 
  function renderAllTodos(todos) {
    var html = '';
    todos.forEach(function(todo) {
      html += todoToHtml(todo);
    });
    ul.innerHTML = html;
  }
 
  function todoToHtml(todo) {
    return '<li><button id="'+todo.localId+'">delete</button>'+todo.text+'</li>';
  }

  function onSubmit(e) {
    e.preventDefault();
    var todo = {
      text: input.value,
      updated: Date.now(),
      remoteId: undefined
    };
    databaseTodosPut(todo, function() {
      // After new todos have been added - rerender all the todos
      refreshView();
      synchronize();
      input.value = '';
    });
  }
 
  function databaseOpen(callback) {
    // Open a database, specify the name and version
    var version = 1;
    var request = indexedDB.open('todos', version);
 
    // Run migrations if necessary
    request.onupgradeneeded = function(e) {
      db = e.target.result;
      e.target.transaction.onerror = databaseError;

      var todoStore = db.createObjectStore('todo', { keyPath: 'localId', autoIncrement: true });
      todoStore.createIndex('remoteId', 'remoteId', { unique: false });
    };

    request.onsuccess = function(e) {
      db = e.target.result;
      callback();
    };
    request.onerror = databaseError;
  }

  function synchronize() {
    request.get(host+'/todos', function(err, res) {
      if (err) {
        return console.error("Cannot connect to server");
      }
      var remoteTodos = res.body;
      databaseTodosGetByDeleted(undefined, function(localTodos) {
        var localTodosRemoteIds = localTodos
          .map(function(todo) { return todo.remoteId; });

        // Loop thorugh local todos and if they haven't been
        // posted to the server, post them.
        localTodos.forEach(function(todo) {

          // If the remote id exists maybe update the text try to update it
          if (todo.remoteId) {

            // Has it been marked for deletion?
            if (todo.deleted) {
              request.del(host+'/todos/'+todo.remoteId)
                .send({ text: todo.text, updated: todo.updated })
                .end(function(res) {
                  // Successful remote delete, now delete locally
                  if (res.ok) {
                    databaseTodosDelete(todo.localId);
                  }
                  refreshView();
                });

            // Otherwise try to update it
            } else {
              request.put(host+'/todos/'+todo.remoteId)
                .send({ text: todo.text, updated: todo.updated })
                .end(function(res) {
                  // Only need to handle the error case (probably a conflict)
                  if (!res.ok) {
                    request.get(host+'/todos/'+todo.remoteId)
                      .end(function(res) {
                        // Todo has been deleted, delete it locally too
                        if (res.status === 404) {
                          databaseTodosDelete(todo.localId);

                        // Otherwise update it with whatever the server thinks is right
                        } else {
                          databaseTodosPut({
                            localId: todo.localId,
                            remoteId: todo.remoteId,
                            text: res.body.text,
                            updated: res.body.updated  
                          });
                        }
                        refreshView();
                      });
                  }
                });          
            }
 
          // Otherwise create on the remote server & update local id
          } else {
            request.post(host+'/todos')
              .send({ text: todo.text, updated: todo.updated })
              .end(function(res) {
                if (res.ok) {
                  todo.remoteId = res.text;
                  databaseTodosPut(todo);

                // If the server rejects the todo (eg. blank text) reject it
                } else if (res.status === 400) {
                  databaseTodosDelete(todo.localId);
                }
                refreshView();
              });
          }
        });
        remoteTodos.forEach(function(todo) {
          var localCopyIndex = localTodosRemoteIds.indexOf(todo._id);

          // We don't have todo, maybe create it?
          if (localCopyIndex === -1) {
            databaseTodosPut({
              text: todo.text,
              remoteId: todo._id,
              updated: todo.updated,
            }, refreshView);
          }
        });
      });
    });
  }

  function refreshView() {
    databaseTodosGetByDeleted(false, renderAllTodos);
  }
 
  function databaseError(e) {
    console.error('An IndexedDB Error has occurred', e);
  }
 
  function databaseTodosPut(todo, callback) {
    var transaction = db.transaction(['todo'], 'readwrite');
    var store = transaction.objectStore('todo');
    var request = store.put(todo);
 
    request.onsuccess = function(e) {
      if (callback) callback();
    };
    request.onerror = databaseError;
  }

  function databaseTodosGetByLocalId(id, callback) {
    var transaction = db.transaction(['todo'], 'readwrite');
    var store = transaction.objectStore('todo');
    var request = store.get(id);
    request.onsuccess = function(e) {
      var result = e.target.result;
      callback(result);
    }
    request.onerror = databaseError;
  };

  function databaseTodosGetByDeleted(deleted, callback) {
    var transaction = db.transaction(['todo'], 'readwrite');
    var store = transaction.objectStore('todo');
 
    // Get everything in the store
    var keyRange = IDBKeyRange.lowerBound(0);
    var cursorRequest = store.openCursor(keyRange);
 
    // This fires once per row in the store, so for simplicity
    // collect the data in an array (data) and send it pass it
    // in the callback in one go
    var data = [];
    cursorRequest.onsuccess = function(e) {
      var result = e.target.result;
 
      // If there's data, add it to array
      if (result) {
        if (deleted === undefined || (deleted === true && result.value.deleted) || (deleted === false && !result.value.deleted)) {
          data.push(result.value); 
        }
        result.continue();
 
      // Reach the end of the data
      } else {
        callback(data);
      }
    };
  }

  function databaseTodosDelete(id, callback) {
    var transaction = db.transaction(['todo'], 'readwrite');
    var store = transaction.objectStore('todo');
    var request = store.delete(id);
    request.onsuccess = function(e) {
      if (callback) callback();
    };
    request.onerror = databaseError;
  }
 
}());
